#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tavern-img-bridge v4: 酒馆自动文生图 中台（纯标准库）
1. 出图完成 → SSE 实时推给酒馆扩展（复用现有 /events 通道）
2. 设置存储：模型 + LoRA 勾选 + 速度档位（size_mult/steps_mult）+ 开关
3. /generate：剧情文本 → DeepSeek 提示词工程器（严格按回复/无词库）→ gen.py 出图 → 推送
4. v4 新增：
   - ComfyUI 地址/DeepSeek key 可配置（model_choice.json 顶层 config；GET/POST /config）
   - 动态模型枚举（GET /model 返回 auto_models：ComfyUI object_info 实时枚举）
   - 自动模型出图（POST /model 选 auto_model → /generate 用 wf_builder 自动构建工作流，
     提交后经 ComfyUI WebSocket 收完成信号（非轮询），失败回退旧 gen.py 路径）
接口：
    GET  /events          SSE 长连接
    POST /push            {"url":..., "prompt":...}
    GET  /model | POST /model
    GET  /loras            枚举全部 LoRA：读 safetensors 头部元数据识别家族（60s 缓存）
    GET  /config | POST /config     {comfy_url, deepseek_key?, llm?:{mode,endpoint,key,model}}
    GET  /config/test | POST /config/test   LLM 连通测试（POST body {endpoint,key,model}? 覆盖，不保存）
    GET  /paths/dialog?kind=model|lora      tkinter 弹 Windows 文件夹选择器
    GET  /enabled | POST /enabled
    GET  /health
    POST /generate        {"text": 剧情全文, "model": key?, "loras": [...], "size_mult":.., "steps_mult":..,
                            "worldinfo": 背景?, "name": 角色名?}  → 202 {"ok":true,"job":"..."}；
                          完成时经 SSE 广播 {"type":"image","url":...,"prompt":...,"model":...}；
                          失败广播 {"type":"error","message":...}
    GET  /jobs            当前/排队任务摘要
事件格式：data: {"type":"image","url":"http://127.0.0.1:8000/tavern-img/xxx.png","model":"...","ts":...}
"""
import base64
import hashlib
import json
import os
import queue
import random
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError, URLError

HOST = "127.0.0.1"
PORT = 8645
MODEL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_choice.json")
ENV_FILE = os.path.expanduser(r"~/AppData/Local/hermes/.env")
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"
DEFAULT_LLM = {"mode": "custom", "endpoint": "https://api.deepseek.com",
               "key": "", "model": "deepseek-chat"}
GEN_DIR = os.path.dirname(os.path.abspath(__file__))
# ── 配置（发布版：从同目录 config.json 读取；文件不存在时按下方默认并提示）──
import json as _json
def _cfg(key, default):
    try:
        _c = _json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"), encoding="utf-8"))
        v = _c.get(key, default)
        if v:
            return v
    except Exception:
        pass
    v = os.environ.get("TAIMG_" + key.upper())
    return v or default

GEN_SERVE_DIR = _cfg("tavern_img_dir", os.path.join(os.path.dirname(os.path.abspath(__file__)), "serve", "tavern-img"))
GEN_SERVE_DIR = GEN_SERVE_DIR.replace("\\", "/")
COMfyUI_ROOT = _cfg("comfy_root", "")
EXTRAPATHS = _cfg("comfy_extra_paths", os.path.join(COMfyUI_ROOT, "extra_model_paths.yaml") if COMfyUI_ROOT else "")
DEFAULT_COMFY_URL = "http://127.0.0.1:8188"

# 通用工作流自动构建器（动态模型出图用；SERVER 常量在调用前由本桥按配置覆盖）
sys.path.insert(0, GEN_DIR)
import wf_builder  # noqa: E402

# 家族 → 中文标注（auto_models label 用）
_FAMILY_LABELS = {
    "anima": "动漫·Anima",
    "sdxl": "SDXL 系列",
    "krea2": "厚涂写实·Krea2",
    "flux": "动态·Flux",
    "unknown": "未识别",
}

# 工程器系统提示词 v2：LLM 只输出 positive + 性别标志；negative 由桥按规则拼（省一半输出时间）
ENGINEER_SYSTEM = """你是文生图提示词工程师。用户会给你一段酒馆角色的剧情回复文本，你输出可直接用于 ComfyUI 文生图的英文正向提示词。
铁律：
1. 严格按剧情文本生成。只描绘文本中确实出现的内容（人物外观/衣着/动作/场景/情绪/道具/在场他人）；不添加、不想象、不引用任何角色卡或历史设定；文本没写的一律不写。
2. 性别按剧情判断：出现"带把的/喉结/少年声/男"等 → 男性/伪娘；正常女性角色 → 女性。
3. 正面词按顺序组装：quality → style → subject → features → clothing → action → shot/camera → lighting → emotion → environment → props。
4. 当前模型族为 {family}。风格词按族：
   - anima: anime style, anime illustration, masterpiece, best quality, detailed face
   - sdxl: 写实系 RAW photo, photorealistic, 35mm lens, depth of field, skin texture；动漫系 anime style
   - krea2: semi-realistic, thick paint, cinematic
   按剧情场景选最合适的（写实向用写实词，动漫向用动漫词）。
5. 只输出一个 JSON 对象，不要任何其他文字：{{"positive": "...", "male": true|false}}（male=true 表示角色是男性/伪娘，male=false 为女性）"""

# 静态预设（本机固有，非通用发布内容）：优先读 presets_static.json（私有文件）；
# 文件缺失/损坏 → MODELS = {}（纯动态模式：自动发现模型 + 自动构建器出图）
# 生成方法（保留本机私房参数用）：python -c "from bridge import ...; dump"（见 git 备注）
STATIC_PRESETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets_static.json")


def _load_presets():
    try:
        with open(STATIC_PRESETS, encoding="utf-8") as f:
            d = json.load(f)
        models = d.get("MODELS", {})
        if isinstance(models, dict) and models:
            return models, d.get("COMPAT", {}), d.get("default_model", "real")
    except Exception:
        pass
    return {}, {}, ""


MODELS, COMPAT, _preset_default = _load_presets()
_default_model = _preset_default or ""
_A = [
    {"file": "anima_context_detailer_base10.safetensors",     "label": "Anima通用·细节增强",      "sm": 0.6, "sc": 0.6},
    {"file": "anima_photorealistic_512-000014.safetensors",  "label": "Anima通用·半写实(皮肤)",   "sm": 0.8, "sc": 0.8},
    {"file": "anima-highres-aesthetic-boost.safetensors",    "label": "Anima通用·高清美感",       "sm": 0.8, "sc": 0.8},
    {"file": "anima-turbo-lora-v0.2.safetensors",            "label": "Anima通用·提速(turbo)",    "sm": 1.0, "sc": 1.0},
]
# MODELS/COMPAT 已文件驱动（presets_static.json）；本地固有预设不在通用代码中
# _default_model 在无预设时为 ""（纯动态模式：键由 auto_models 提供）
_VALID_MULTS = {"size": [0.75, 1.0, 1.25], "steps": [0.5, 0.75, 1.0, 1.5]}

_clients = []
_clients_lock = threading.Lock()
_events = []
_model_lock = threading.Lock()
_job_lock = threading.Lock()
_jobs = []            # [job_id, status(running/pending/done/error), created, done, result]
_job_queue = queue.Queue()
_llm_lock = threading.Lock()
_last_gen_fp = {"fp": "", "ts": 0.0}   # 同文本指纹 60s 去重（桥收口，防前端多触发）
_cancel_event = threading.Event()      # 急停：置位后正在跑的 job 停止（不再发布图片）


def _text_fp(text: str) -> str:
    import hashlib
    return hashlib.sha1(text.strip().encode("utf-8", "ignore")).hexdigest()[:16]


def _default_state():
    rec = MODELS.get(_default_model) or {}
    return {"key": _default_model, "loras": list(rec.get("default_loras", [])),
            "size_mult": 1.0, "steps_mult": 1.0, "enabled": True}


# ── 配置（model_choice.json 顶层 config: {comfy_url, deepseek_key}）────
def _load_raw_json() -> dict:
    try:
        with open(MODEL_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save_raw_json(d: dict):
    with open(MODEL_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def _comfy() -> str:
    """当前配置的 ComfyUI 地址（未配置时默认 127.0.0.1:8188）"""
    try:
        return str(_load_raw_json().get("config", {}).get("comfy_url") or DEFAULT_COMFY_URL)
    except Exception:
        return DEFAULT_COMFY_URL


def _load_llm() -> dict:
    """合并保存的 llm 配置与默认值（不返回时用默认；key 可能为空串）"""
    llm = dict(DEFAULT_LLM)
    try:
        saved = (_load_raw_json().get("config") or {}).get("llm")
        if isinstance(saved, dict):
            for k in ("mode", "endpoint", "key", "model"):
                if isinstance(saved.get(k), str):
                    llm[k] = saved[k].strip()
    except Exception:
        pass
    return llm


def _load_deepseek_key() -> str:
    """优先级：config.llm.key → config.deepseek_key（旧字段） → .env DEEPSEEK_API_KEY"""
    try:
        cfg = _load_raw_json().get("config") or {}
        k = str((cfg.get("llm") or {}).get("key") or "").strip()
        if k:
            return k
        k = str(cfg.get("deepseek_key") or "").strip()
        if k:
            return k
    except Exception:
        pass
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("DEEPSEEK_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        return ""
    return ""


def _load_state():
    try:
        with open(MODEL_FILE, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return _default_state()
    key = d.get("key", _default_model)
    if key in COMPAT:
        key = COMPAT[key][0]
    if key not in MODELS:
        key = _default_model
    rec = MODELS.get(key) or {}
    allowed = {l["file"] for l in rec.get("loras", [])}
    loras = list(rec.get("default_loras", []))
    if d.get("loras") is not None:
        loras = [x for x in d["loras"] if x in allowed]
    loras = list(dict.fromkeys(loras))
    sm = d.get("size_mult", 1.0)
    if sm not in _VALID_MULTS["size"]:
        sm = 1.0
    stm = d.get("steps_mult", 1.0)
    if stm not in _VALID_MULTS["steps"]:
        stm = 1.0
    return {"key": key, "loras": loras, "size_mult": sm, "steps_mult": stm,
            "enabled": bool(d.get("enabled", True)),
            "auto_model": (d.get("auto_model") if isinstance(d.get("auto_model"), str) and d.get("auto_model") else None),
            "family": d.get("family") if isinstance(d.get("family"), str) else None}


def _save_state(st) -> bool:
    if st["key"] not in MODELS:
        return False
    with _model_lock:
        raw = _load_raw_json()          # 保留顶层 config/extra_dirs 等字段
        raw.update(st)
        with open(MODEL_FILE, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, indent=2)
    return True


def broadcast(event: dict):
    _events.append(event)
    if len(_events) > 20:
        _events.pop(0)
    with _clients_lock:
        for (q, _lock) in list(_clients):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass


# ── 酒馆主 API 读取（服务端文件最可靠；key 只在桥内，不出桥）────
TAVERN_DATA_DIR = _cfg("tavern_data_dir", "")


# ── 节点体检：检测工作流所需节点是否齐全（连接 ComfyUI 时提示）────
Wf_NODES = ["CheckpointLoaderSimple", "UNETLoader", "CLIPLoader", "VAELoader",
            "DualCLIPLoader", "CLIPTextEncode", "KSampler", "VAEDecode", "SaveImage",
            "EmptyLatentImage", "EmptySD3LatentImage", "LoraLoader"]


def _node_test():
    """探测 wf_builder 所需全部节点 → {ok, nodes, missing, total, found}"""
    nodes = {}
    for cls in Wf_NODES:
        try:
            with urllib.request.urlopen(_comfy() + f"/object_info/{cls}", timeout=6) as r:
                d = json.loads(r.read().decode("utf-8"))
            nodes[cls] = cls in d
        except Exception:
            nodes[cls] = False
    missing = [c for c in Wf_NODES if not nodes[c]]
    return {"ok": not missing, "nodes": nodes, "missing": missing,
            "total": len(Wf_NODES), "found": len(Wf_NODES) - len(missing)}


def _read_tavern_api():
    """读酒馆 settings.json + secrets.json → (endpoint, model, key, err)；失败各字段为 '' """
    try:
        with open(os.path.join(TAVERN_DATA_DIR, "settings.json"), encoding="utf-8") as f:
            st = json.load(f)
        oai = st.get("oai_settings", {}) or {}
        source = oai.get("chat_completion_source", "")
        endpoint = ""
        if source in ("custom", "openai"):
            endpoint = oai.get("custom_url") or oai.get("reverse_proxy") or ""
        elif source:
            endpoint = oai.get(f"{source}_endpoint") or oai.get("reverse_proxy") or ""
        model = oai.get(f"{source}_model") or oai.get("openai_model") or ""
    except Exception as e:
        return "", "", "", f"读取 settings.json 失败: {e}"
    key = ""
    try:
        with open(os.path.join(TAVERN_DATA_DIR, "secrets.json"), encoding="utf-8") as f:
            sec = json.load(f)
        skey = {"custom": "api_key_custom", "openai": "api_key_openai"}.get(source, "")
        raw = sec.get(skey) if skey else None
        if isinstance(raw, str):
            raw = json.loads(raw)
        if isinstance(raw, list):
            pick = None
            for it in raw:
                if isinstance(it, dict) and it.get("value") and it.get("active") is True:
                    pick = it.get("value", "")
                    break
            if pick is None:
                for it in raw:
                    if isinstance(it, dict) and it.get("value"):
                        pick = it.get("value", "")
                        break
            key = pick or ""
    except Exception as e:
        return endpoint, model, "", f"读取 secrets.json 失败: {e}"
    return endpoint, model, key, ""


# ── 模型目录自选（extra_model_paths.yaml 管理 + 自动识别统计）────
def _oi_enum(class_type, field):
    try:
        with urllib.request.urlopen(f"{_comfy()}/object_info/{class_type}", timeout=10) as r:
            d = json.loads(r.read().decode("utf-8")).get(class_type, {})
        v = d.get("input", {}).get("required", {}).get(field, [None])[0]
        return v if isinstance(v, list) else []
    except Exception:
        return []


def _comfy_post(path, payload, timeout=60):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(_comfy() + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _comfy_get(path, timeout=30):
    with urllib.request.urlopen(_comfy() + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ── 动态模型枚举（UNETLoader.unet_name + CheckpointLoaderSimple.ckpt_name，合并非并排序，60 条内）────
_auto_cache = {"ts": 0.0, "data": None}
_auto_lock = threading.Lock()


def _auto_models(force=False) -> list:
    with _auto_lock:
        if not force and _auto_cache["data"] is not None and time.time() - _auto_cache["ts"] < 60:
            return _auto_cache["data"]
    names = set()
    names.update(_oi_enum("UNETLoader", "unet_name"))
    names.update(_oi_enum("CheckpointLoaderSimple", "ckpt_name"))
    out = []
    for f in sorted(names):
        fam = wf_builder.detect_family(f)
        out.append({"file": f, "family": fam,
                    "label": f"{_FAMILY_LABELS.get(fam, '未知')} — {f}"})
        if len(out) >= 60:
            break
    with _auto_lock:
        _auto_cache["ts"] = time.time()
        _auto_cache["data"] = out
    return out


# ── LoRA 枚举：LoraLoader.lora_name + 读 safetensors 头元数据识别家族（60s 缓存）────
LORAS_ROOT = os.path.join(COMfyUI_ROOT, "models", "loras")
# 家族 → 关键词（按此优先级匹配；"ae" 要求独立成词防 "vae/name" 误报）
_LORA_FAMILY_KWS = [
    ("anima", ("sd3", "qwen", "anima", "imax")),
    ("sdxl", ("sdxl", "nadebrave", "pony", "illustrious")),
    ("flux", ("flux", "ae")),
    ("krea2", ("krea2", "zit", "zimage")),
]
_LORA_META_KEYS = ("modelspec.architecture", "ss_network_module",
                   "ss_base_model_version", "ss_sd_model_name")
_lora_cache = {"ts": 0.0, "data": None}
_lora_lock = threading.Lock()


def _norm_kw(s) -> str:
    return re.sub(r"[- .]+", "_", str(s or "").lower())


def _kw_hit(kw: str, hay: str) -> bool:
    if kw == "ae":
        return bool(re.search(r"(?<![a-z0-9])ae(?![a-z0-9])", hay))
    return kw in hay


def _lora_family(meta: dict, file: str) -> str:
    """元数据关键词判家族；命中不了再回退文件名；仍无 → unknown。
    按字段可靠性分层：architecture/network_module/base_model_version → sd_model_name → 文件名，
    因 ss_sd_model_name 常含训练机路径（如 D:\\flux-aki\\...\\anima_baseV10.safetensors）会带噪声。"""
    hay_fmt = {k: _norm_kw(meta.get(k) or "") for k in _LORA_META_KEYS}
    levels = [
        [hay_fmt["modelspec.architecture"], hay_fmt["ss_network_module"],
         hay_fmt["ss_base_model_version"]],
        [hay_fmt["ss_sd_model_name"]],
        [_norm_kw(file)],
    ]
    for level in levels:
        hay = " ".join(level)
        for fam, kws in _LORA_FAMILY_KWS:
            if any(_kw_hit(k, hay) for k in kws):
                return fam
    return "unknown"


def _safetensors_meta(path: str, cap: int = 2 * 1024 * 1024):
    """读 safetensors 头部：前 8 字节 = 头长度（标准大端；部分发布者改小端，两种都试），
    随后为 JSON 字典。JSON 跨多 chunk 读到能解析（64KB → 2MB 扩容）。返回 __metadata__ dict，
    读失败返回 None。"""
    try:
        with open(path, "rb") as f:
            head = f.read(8)
            if len(head) < 8:
                return None
            sizes = []
            for endian in (">", "<"):
                try:
                    n = struct.unpack(endian + "Q", head)[0]
                except Exception:
                    continue
                if 8 <= n <= cap:
                    sizes.append(n)
            for n in sizes:
                f.seek(8)
                buf = b""
                while len(buf) < n:
                    chunk = f.read(min(65536, n - len(buf)))
                    if not chunk:
                        break
                    buf += chunk
                try:
                    return (json.loads(buf[:n].decode("utf-8")) or {}).get("__metadata__") or {}
                except Exception:
                    continue
            # 长度字段异常：增量扩容直到能解析（raw_decode 容忍尾部二进制）
            f.seek(8)
            buf = b""
            dec = json.JSONDecoder()
            while len(buf) < cap:
                chunk = f.read(65536)
                if not chunk:
                    break
                buf += chunk
                try:
                    obj, _ = dec.raw_decode(buf.decode("utf-8", "ignore"))
                    if isinstance(obj, dict):
                        return obj.get("__metadata__") or {}
                except Exception:
                    continue
            return None
    except Exception:
        return None


def _loras(force=False) -> list:
    """枚举 LoraLoader.lora_name 全部文件，逐个读头元数据判家族；60s 缓存。"""
    with _lora_lock:
        if not force and _lora_cache["data"] is not None and time.time() - _lora_cache["ts"] < 60:
            return _lora_cache["data"]
    out = []
    for file in _oi_enum("LoraLoader", "lora_name"):
        meta_err = False
        meta = None
        parts = str(file).split("/")
        if os.path.isabs(file) or any(p in ("", ".", "..") for p in parts):
            meta_err = True            # 路径非法（防御，不越 LORAS_ROOT）
        else:
            p = os.path.join(LORAS_ROOT, *parts)
            if os.path.isfile(p):
                meta = _safetensors_meta(p)
            else:
                meta_err = True        # 枚举里有但磁盘上不存在
        if meta is None:
            fam = "unknown"
            meta_err = True
        else:
            fam = _lora_family(meta, file)
        base = os.path.basename(file)
        label = (os.path.splitext(base)[0] or base)[:60]
        item = {"file": file, "family": fam, "label": label}
        if meta_err:
            item["meta_err"] = True
        out.append(item)
    out.sort(key=lambda x: x["file"])
    with _lora_lock:
        _lora_cache["ts"] = time.time()
        _lora_cache["data"] = out
    return out


def _recognized():
    return {
        "models": len(_oi_enum("CheckpointLoaderSimple", "ckpt_name")) + len(_oi_enum("UNETLoader", "unet_name")),
        "loras": len(_oi_enum("LoraLoader", "lora_name")),
        "clips": len(_oi_enum("CLIPLoader", "clip_name")),
        "vaes": len(_oi_enum("VAELoader", "vae_name")),
    }


def _paths_state():
    prefs = {}
    try:
        with open(MODEL_FILE, encoding="utf-8") as f:
            prefs = json.load(f).get("extra_dirs", {})
    except Exception:
        pass
    yaml_text = ""
    if os.path.exists(EXTRAPATHS):
        try:
            with open(EXTRAPATHS, encoding="utf-8") as f:
                yaml_text = f.read()[:1200]
        except Exception:
            pass
    return {"prefs": prefs, "yaml_exists": bool(yaml_text), "yaml_content": yaml_text,
            "recognized": _recognized()}


def _save_extrapaths(model_root: str, lora_dir: str) -> str:
    """在 extra_model_paths.yaml 追加 TAVERN_USER 条目（原文件不存在则创建）"""
    entries = []
    if model_root:
        entries.append(f"  \"TAVERN_USER\":\n"
                       f"    base_path: \"{model_root}\"\n"
                       f"    diffusion_models: \"diffusion_models\"\n"
                       f"    checkpoints: \"checkpoints\"\n"
                       f"    loras: \"loras\"\n"
                       f"    vae: \"vae\"\n"
                       f"    clip: \"clip\"\n")
    if lora_dir and (not model_root or lora_dir != os.path.join(model_root, "loras")):
        entries.append(f"  \"TAVERN_LORA\":\n"
                       f"    loras: \"{lora_dir}\"\n")
    if not entries:
        return ""
    body = "# tavern2img 用户自选目录（由桥写入；修改后需重启 ComfyUI 生效）\n" + "".join(entries)
    with open(EXTRAPATHS, "w", encoding="utf-8") as f:
        f.write(body)
    return body


def _pick(names: list, kws: tuple, prefer=None):
    if not names:
        return None
    if prefer and prefer in names:
        return prefer
    for kw in kws:
        for n in names:
            if kw.lower() in n.lower():
                return n
    return None


# ── 文件夹选择对话框（tkinter，计划任务桌面会话弹 Windows 选择器）────
_dialog_lock = threading.Lock()


def _pick_folder_dialog(title: str) -> str:
    """弹 Windows 文件夹选择器。返回选中路径；取消/未选返回空串。必须挂根窗口并 destroy。"""
    import tkinter
    from tkinter import filedialog
    with _dialog_lock:                      # 防并发两次弹窗（tkinter 单线程限制）
        root = None
        try:
            root = tkinter.Tk()
            root.withdraw()                 # 根窗口隐藏，只显对话框
            try:
                root.attributes("-topmost", True)
            except Exception:
                pass
            path = filedialog.askdirectory(parent=root, title=title)
            return path or ""
        finally:
            if root is not None:
                try:
                    root.destroy()
                except Exception:
                    pass


def _chat_completions(endpoint: str, key: str, model: str,
                      max_tokens: int = 1200, messages: list = None,
                      timeout: float = 120.0) -> dict:
    """OpenAI 兼容 chat/completions 真实请求。endpoint 以 /chat/completions 结尾则直接用，否则拼接。"""
    ep = (endpoint or "").strip().rstrip("/")
    if not ep:
        raise RuntimeError("endpoint 为空")
    url = ep if ep.endswith("/chat/completions") else ep + "/chat/completions"
    body = {"model": model,
            "messages": messages if messages is not None else [{"role": "user", "content": "hi"}],
            "temperature": 0.7, "max_tokens": max_tokens}
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _config_test(over: dict) -> dict:
    """真实发一次 chat/completions（max_tokens=1，超时 20s）测 LLM 连通。over={endpoint,key,model} 可选覆盖，不保存。"""
    llm = _load_llm()
    endpoint = str(over.get("endpoint") or llm.get("endpoint") or "").strip()
    model = str(over.get("model") or llm.get("model") or "").strip()
    key = str(over.get("key") or "").strip() or _load_deepseek_key()
    if not endpoint:
        return {"ok": False, "error": "endpoint 未配置"}
    if not key:
        return {"ok": False, "error": "API Key 未配置（llm.key / deepseek_key / .env）"}
    if not model:
        return {"ok": False, "error": "model 未配置"}
    t0 = time.time()
    try:
        _chat_completions(endpoint, key, model, max_tokens=1,
                          messages=[{"role": "user", "content": "hi"}], timeout=20)
    except HTTPError as e:
        fb = f"HTTP {e.code}"
        if e.reason:
            fb += f" {e.reason}"
        return {"ok": False, "error": fb}
    except URLError as e:
        return {"ok": False, "error": f"网络连接失败: {e.reason}"}
    except TimeoutError:
        return {"ok": False, "error": "请求超时（20s）"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}
    return {"ok": True, "latency_ms": int((time.time() - t0) * 1000)}


def _call_llm(system: str, user: str) -> dict:
    key = _load_deepseek_key()
    if not key:
        raise RuntimeError("未配置 LLM API Key（config.llm.key / deepseek_key / .env）")
    llm = _load_llm()
    j = _chat_completions(llm.get("endpoint", ""), key, llm.get("model", ""),
                          max_tokens=1200,
                          messages=[{"role": "system", "content": system},
                                    {"role": "user", "content": user}],
                          timeout=120)
    content = j["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        raise RuntimeError(f"LLM 未返回 JSON: {content[:200]}")
    out = json.loads(m.group(0))
    pos = str(out.get("positive", "")).strip()
    neg = str(out.get("negative", "")).strip()
    if not pos:
        raise RuntimeError("LLM 返回的 positive 为空")
    return {"positive": pos, "negative": neg}


PROMPT_EDIT_FILE = os.path.join(GEN_DIR, "prompt_edit.txt")


def _prompt_system(family: str) -> str:
    """工程器系统提示词：默认模板（替换 family）→ 若用户在外层覆盖（prompt_edit.txt 非空）则用它"""
    base = ENGINEER_SYSTEM.replace("{family}", family if family in ("anima", "sdxl", "krea2", "flux") else "anima")
    try:
        if os.path.exists(PROMPT_EDIT_FILE):
            over = open(PROMPT_EDIT_FILE, encoding="utf-8").read().strip()
            if over:
                base = over
    except Exception:
        pass
    return base


def _engineer(text: str, family: str, worldinfo: str = "") -> dict:
    system = _prompt_system(family)
    user = (f"模型族：{family}\n"
            + (f"世界设定背景：\n{worldinfo[:1500]}\n" if worldinfo else "")
            + f"剧情回复文本：\n{text[:6000]}")
    r = _call_llm(system, user)
    male = bool(r.get("male", False))
    neg = ("bad quality, worst quality, lowres, blurry, extra limbs, deformed hands, "
           "text, watermark" + (", female, woman, girl, big breasts, cleavage, westerner, caucasian" if male else ""))
    return {"positive": r["positive"], "negative": neg, "male": male, "raw_user": text}


_current_proc = None  # gen.py 子进程句柄（急停时 terminate）


_CLOUD_CACHE = os.path.join(GEN_DIR, "cloud_cache")


def _fetch_comfy_view(fname: str, subfolder: str = "", type_: str = "output") -> str:
    """云部署取图：从 ComfyUI /view 拉回字节流，存本地缓存目录返回本地路径（无本地文件时用）"""
    os.makedirs(_CLOUD_CACHE, exist_ok=True)
    import urllib.parse
    q = urllib.parse.urlencode({"filename": fname, "subfolder": subfolder, "type": type_})
    url = _comfy() + "/view?" + q
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    safe = re.sub(r"[^\w\.\-]+", "_", fname)[-80:] or "img.png"
    local = os.path.join(_CLOUD_CACHE, safe)
    with open(local, "wb") as f:
        f.write(data)
    return local


def _run_gen(settings: dict, prompt: str, negative: str) -> str:
    cmd = [sys.executable, os.path.join(GEN_DIR, "gen.py"),
           "--model", settings["key"],
           "--size-mult", str(settings["size_mult"]),
           "--steps-mult", str(settings["steps_mult"]),
           "--prompt", prompt,
           "--negative", negative,
           "--prefix", "tavern_auto"]
    if settings["loras"]:
        cmd += ["--loras", ",".join(f"{f}@0.8" for f in settings["loras"])]
    global _current_proc
    try:
        _current_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         text=True, cwd=GEN_DIR)
        out, _err = _current_proc.communicate(timeout=900)
    except subprocess.TimeoutExpired:
        if _current_proc:
            _current_proc.kill()
        raise RuntimeError("gen.py 超时")
    finally:
        _current_proc = None
    for line in out.splitlines():
        if line.startswith("OK:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError(f"gen.py 失败: {out[-400:]}")


# ── 最小 WebSocket 客户端（纯标准库，仅用于 ComfyUI /ws 事件完成信号）────
class _WSClient:
    """握手 + 读帧 + ping/pong。只支持一个完整消息的简单场景（ComfyUI 事件足够）。"""

    def __init__(self, url: str):
        p = urlparse(url)
        self.host = p.hostname or "127.0.0.1"
        self.port = p.port or (443 if p.scheme == "wss" else 80)
        self.path = (p.path or "/") + (("?" + p.query) if p.query else "")
        self.sock = None

    def connect(self, timeout=30):
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {self.path} HTTP/1.1\r\n"
               f"Host: {self.host}:{self.port}\r\n"
               f"Upgrade: websocket\r\n"
               f"Connection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n"
               f"\r\n")
        self.sock.sendall(req.encode("utf-8"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("WS 握手无响应")
            buf += chunk
            if len(buf) > 65536:
                raise RuntimeError("WS 握手响应异常")
        head = buf.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        if "101" not in head:
            raise RuntimeError(f"WS 握手失败: {head[:200]}")
        # 校验 Sec-WebSocket-Accept（宽松策略：仅提示不断连）
        expect = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        hdr = buf.split(b"\r\n\r\n", 1)[0].decode("utf-8", "replace")
        if expect not in hdr:
            print(f"[auto] 注意: Sec-WebSocket-Accept 校验未通过（继续运行）", flush=True)

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("WS 连接中断")
            buf += chunk
        return buf

    def _send_frame(self, op: int, payload: bytes = b""):
        head = bytes([0x80 | op])
        mask = os.urandom(4)
        ln = len(payload)
        if ln < 126:
            head += bytes([0x80 | ln])
        elif ln < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", ln)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", ln)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def read_frame(self):
        """返回 (opcode, payload)；opcode: 1=text 2=binary 8=close 9=ping 10=pong"""
        h0, h1 = self._read_exact(2)
        op = h0 & 0x0F
        ln = h1 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", self._read_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self._read_exact(8))[0]
        masked = bool(h1 & 0x80)
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(ln) if ln else b""
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return op, payload

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *a):
        self.close()


def _ws_event(data):
    """ComfyUI WS 消息 → (etype, edata)：二进制帧去 4 字节 event-id 后是 [type, payload] 或文本帧 {'type','data'}"""
    if isinstance(data, list) and len(data) >= 2:
        return str(data[0]), (data[1] if isinstance(data[1], dict) else {})
    if isinstance(data, dict):
        d = data.get("data")
        return str(data.get("type", "")), (d if isinstance(d, dict) else {})
    return "", {}


def _wait_comfy_ws(prompt_id: str, client_id: str, timeout: float = 900.0):
    """WebSocket 等完成信号。返回 (ok, err)：
    execution_success(prompt_id 匹配) → (True, "")；execution_error → (False, err)；
    超时 → (False, "超时")；连接/帧异常 → (False, ...)。"""
    url = _comfy()
    ws_url = (url.replace("http://", "ws://", 1).replace("https://", "wss://", 1)
              .rstrip("/") + f"/ws?clientId={client_id}")
    print(f"[auto] WS 等待: {ws_url} (pid={prompt_id})", flush=True)
    try:
        ws = _WSClient(ws_url)
        ws.connect()
    except Exception as e:
        return False, f"WS 连接失败: {e}"
    try:
        deadline = time.time() + timeout
        while time.time() < deadline:
            remain = deadline - time.time()
            ws.sock.settimeout(min(remain, 5))
            try:
                op, payload = ws.read_frame()
            except socket.timeout:
                continue
            except Exception as e:
                return False, f"WS 读帧异常: {e}"
            if op == 9:                                 # ping → pong
                try:
                    ws._send_frame(10, payload)
                except Exception:
                    pass
                continue
            if op == 8:
                return False, "WS 连接被服务端关闭"
            if op not in (1, 2):
                continue
            try:
                if op == 2:                             # 二进制帧：4 字节 event-id 前缀 + JSON 数组
                    if len(payload) < 4:
                        continue
                    raw = payload[4:]
                    data = json.loads(raw.decode("utf-8", "replace"))
                else:
                    data = json.loads(payload.decode("utf-8", "replace"))
                etype, edata = _ws_event(data)
            except Exception:
                continue
            if etype == "execution_success":
                if not edata.get("prompt_id") or str(edata.get("prompt_id")) == str(prompt_id):
                    print(f"[auto] WS 完成信号: {prompt_id}", flush=True)
                    return True, ""
                continue
            if etype == "execution_error":
                return False, f"ComfyUI 执行错误: {json.dumps(edata, ensure_ascii=False)[:600]}"
            if etype == "status" and edata.get("status", {}).get("status_str") in ("error", "error_message"):
                return False, f"ComfyUI 状态异常: {json.dumps(edata, ensure_ascii=False)[:600]}"
        return False, f"WS 等待超时（{int(timeout)}s）"
    finally:
        ws.close()


WF_CUSTOM_FILE = os.path.join(GEN_DIR, "wf_custom.json")


def _load_wf_custom() -> dict:
    """自定义工作流配置：{enabled: bool, wf: {节点图}}；无/损坏 → {"enabled": False, "wf": {}}"""
    try:
        if os.path.exists(WF_CUSTOM_FILE):
            d = json.load(open(WF_CUSTOM_FILE, encoding="utf-8"))
            if isinstance(d, dict) and d.get("wf"):
                return {"enabled": bool(d.get("enabled", False)), "wf": d["wf"]}
    except Exception:
        pass
    return {"enabled": False, "wf": {}}


def _apply_wf_custom(wf: dict, prompt: str, negative: str) -> dict:
    """把自定义 JSON 变成可用节点图：{prompt}/{negative} 占位（可选）替换"""
    out = {}
    for nid, node in wf.items():
        if isinstance(node, dict):
            node = dict(node)
            inputs = dict(node.get("inputs", {}))
            for k, v in list(inputs.items()):
                if isinstance(v, str):
                    inputs[k] = v.replace("{prompt}", prompt).replace("{negative}", negative)
            out[nid] = {"class_type": node.get("class_type", ""),
                        "inputs": inputs,
                        "_meta": node.get("_meta", {})}
    return out


def _run_auto_gen(settings: dict, prompt: str, negative: str) -> str:
    """自动模型出图：wf_builder 构建工作流 → ComfyUI /prompt（带 client_id）→
    WebSocket 等完成（兜底 900s）→ /history 取图。返回 PNG 绝对路径。"""
    auto_file = settings.get("auto_model")
    family = settings.get("family") or wf_builder.detect_family(auto_file)
    loras = [(f, 0.8, 0.8) for f in settings.get("loras", [])]
    print(f"[auto] 构建工作流: model={auto_file} family={family} loras={[l[0] for l in loras]} "
          f"size={settings.get('size_mult')}x steps={settings.get('steps_mult')}x", flush=True)
    wf_builder.SERVER = _comfy()          # 让 wf_builder 的资源探测走配置地址
    wc = _load_wf_custom()
    if wc["enabled"] and wc["wf"]:
        wf = _apply_wf_custom(wc["wf"], prompt, negative)
        print(f"[auto] 使用自定义工作流（{len(wf)} 节点，用户 JSON 全权控制）", flush=True)
    else:
        wf = wf_builder.build_workflow(model_file=auto_file, family=family, loras=loras,
                                       size_mult=settings.get("size_mult", 1.0),
                                       steps_mult=settings.get("steps_mult", 1.0),
                                       prompt=prompt, negative=negative)
        for n in wf.values():             # 随机 seed（build_workflow 默认固定 0）
            if n.get("class_type") == "KSampler":
                n["inputs"]["seed"] = random.randint(0, 2**31 - 1)
    client_id = uuid.uuid4().hex
    resp = _comfy_post("/prompt", {"prompt": wf, "client_id": client_id}, timeout=60)
    pid = str(resp["prompt_id"])
    print(f"[auto] 已提交: {pid}", flush=True)
    ok, err = _wait_comfy_ws(pid, client_id, timeout=900)
    if not ok:
        raise RuntimeError(f"自动出图等待失败: {err}")
    h = _comfy_get(f"/history/{pid}")
    node = h.get(pid, {})
    outs = node.get("outputs", {})
    for _nid, nout in outs.items():
        for it in nout.get("images", []):
            fname = it.get("filename")
            sub = it.get("subfolder") or ""
            p = os.path.normpath(os.path.join(COMfyUI_ROOT, "output", sub, fname))
            if not os.path.exists(p):
                # 云部署：输出在远程服务器 → 经 ComfyUI /view 拉回本地再发布
                local = _fetch_comfy_view(fname, sub, it.get("type") or "output")
                print(f"[auto] 云取图: {fname} -> {local}", flush=True)
                return local
            return p
    raise RuntimeError("完成但没找到输出图（/history 无图片输出）")


def _publish(png: str, prompt: str, model: str, name: str = "生图") -> str:
    cmd = [sys.executable, os.path.join(GEN_DIR, "publish_image.py"),
           "--png", png, "--prompt", prompt, "--model", model, "--name", name]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=GEN_DIR)
    if r.returncode != 0:
        # 错误也尝试拷贝目录推断（发布脚本失败时直接报错）
        raise RuntimeError(f"publish 失败: {(r.stderr or r.stdout)[-300:]}")
    return (r.stdout or "").splitlines()[0] if r.stdout else ""  # [OK] url 之类


def _job_worker():
    while True:
        job = _job_queue.get()
        _cancel_event.clear()   # 新任务开始：重置急停标记
        try:
            st = _load_state()
            payload = job["payload"]
            if payload.get("model") in MODELS:
                st = dict(st)
                st["key"] = payload["model"]
                allowed = {l["file"] for l in MODELS[st["key"]]["loras"]}
                st["loras"] = [x for x in payload.get("loras", st["loras"]) if x in allowed]
                st["size_mult"] = payload.get("size_mult", st["size_mult"])
                st["steps_mult"] = payload.get("steps_mult", st["steps_mult"])
            if not st["enabled"]:
                raise RuntimeError("文生图已关闭")
            wf = payload.get("worldinfo", "")[:1500]
            print(f"[gen] job {job['id']}: LLM 提示词工程器…", flush=True)
            broadcast({"type": "stage", "stage": "engineer", "msg": "🤖 提示词生成中…", "ts": time.time()})
            fam = st.get("family") if st.get("auto_model") else MODELS[st["key"]]["family"]
            prompt = _engineer(payload.get("text", ""), fam, wf)
            print(f"[gen] 提示词完成: {prompt['positive'][:120]}", flush=True)
            broadcast({"type": "stage", "stage": "submit",
                       "msg": "✅ 提示词生成完成，开始生图任务…", "ts": time.time()})
            if _cancel_event.is_set():
                raise RuntimeError("任务已急停")
            print(f"[gen] 出图中: {st['key']} loras={st['loras']} "
                  f"{st['size_mult']}x/{st['steps_mult']}x", flush=True)
            if st.get("auto_model"):
                try:
                    png = _run_auto_gen(st, prompt["positive"], prompt["negative"])
                except SystemExit as e:
                    print(f"[gen] 自动模型路径不可用，回退 gen.py: {e}", flush=True)
                    broadcast({"type": "stage", "stage": "retry",
                               "msg": "🔄 首次出图失败，正在自动重试（备用方案）…", "ts": time.time()})
                    png = _run_gen(st, prompt["positive"], prompt["negative"])
                except Exception as e:
                    print(f"[gen] 自动模型路径失败，回退 gen.py: {e}", flush=True)
                    broadcast({"type": "stage", "stage": "retry",
                               "msg": "🔄 首次出图失败，正在自动重试（备用方案）…", "ts": time.time()})
                    png = _run_gen(st, prompt["positive"], prompt["negative"])
            else:
                png = _run_gen(st, prompt["positive"], prompt["negative"])
            label = st.get("auto_model") or st["key"]
            url = _publish(png, prompt["positive"], label, payload.get("name", "生图"))
            # 注：_publish 内部走 publish_image.py → POST /push → 已广播 image 事件（唯一广播点，防重复）
            job["result"] = {"ok": True, "png": png, "url": url}
            print(f"[gen] job {job['id']} DONE: {url}", flush=True)
        except Exception as e:
            print(f"[gen] job {job['id']} ERROR: {e}", flush=True)
            if _cancel_event.is_set():
                job["result"] = {"ok": False, "error": "已急停"}
            else:
                broadcast({"type": "error", "message": str(e)[:300], "ts": time.time()})
                job["result"] = {"ok": False, "error": str(e)}
        job["status"] = "done" if job["result"].get("ok") else "error"
        job["done"] = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = "tavern-img-bridge/3.0"
    protocol_version = "HTTP/1.1"

    def handle_one_request(self):
        # 只静默连接类断开（WinError 10053/10054 = 客户端主动断开）；其余异常必须抛出来（否则 POST 无响应）
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError):
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-cache")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _reply_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/events":
            self._serve_events()
        elif path == "/health":
            st = _load_state()
            self._reply_json({"status": "ok", "clients": len(_clients), "events": len(_events),
                              "model": st["key"], "enabled": st["enabled"]})
        elif path == "/model":
            st = _load_state()
            resp = {"key": st["key"], "loras": st["loras"], "size_mult": st["size_mult"],
                    "steps_mult": st["steps_mult"], "enabled": st["enabled"],
                    "options": MODELS, "recipe": MODELS.get(st["key"]) or {}}
            resp["auto_models"] = _auto_models(force="refresh=1" in self.path)
            if st.get("auto_model"):
                resp["auto_model"] = st["auto_model"]
                resp["family"] = st.get("family")
            self._reply_json(resp)
        elif path == "/loras":
            self._reply_json({"ok": True, "loras": _loras(force="refresh=1" in self.path),
                              "ts": time.time()})
        elif path == "/nodetest":
            self._reply_json(_node_test())
        elif path == "/comfycheck":
            try:
                _comfy_get("/system_stats")
                self._reply_json({"ok": True})
            except Exception as e:
                self._reply_json({"ok": False, "error": str(e)[:120]})
        elif path == "/workflow":
            wc = _load_wf_custom()
            self._reply_json({"ok": True, "enabled": wc["enabled"], "wf": wc["wf"]})
        elif path == "/prompt":
            over = ""
            if os.path.exists(PROMPT_EDIT_FILE):
                try:
                    over = open(PROMPT_EDIT_FILE, encoding="utf-8").read()
                except Exception:
                    over = ""
            self._reply_json({"system": ENGINEER_SYSTEM, "override": over,
                              "active": bool(over.strip())})
        elif path == "/config":
            llm = _load_llm()
            self._reply_json({"comfy_url": _comfy(),
                              "llm": {"mode": llm.get("mode", "custom"),
                                      "endpoint": llm.get("endpoint", ""),
                                      "model": llm.get("model", ""),
                                      "key_configured": bool(_load_deepseek_key())},
                              "deepseek_configured": bool(_load_deepseek_key())})
        elif path == "/config/tavern":
            endpoint, model, key, err = _read_tavern_api()
            if err:
                self._reply_json({"ok": False, "error": err}, 500)
                return
            if not endpoint or not model or not key:
                self._reply_json({"ok": False,
                                  "error": f"酒馆主 API 信息不完整（endpoint={bool(endpoint)} model={bool(model)} key={bool(key)}）"}, 400)
                return
            llm = _load_llm()
            llm.update({"mode": "tavern", "endpoint": endpoint, "model": model, "key": key})
            cfg = dict(_load_raw_json().get("config") or {})
            cfg["llm"] = llm
            _save_raw_json({"key": _load_state()["key"], "loras": _load_state()["loras"],
                            "size_mult": _load_state()["size_mult"], "steps_mult": _load_state()["steps_mult"],
                            "enabled": _load_state()["enabled"],
                            "extra_dirs": _load_raw_json().get("extra_dirs", {}),
                            "auto_model": _load_raw_json().get("auto_model", ""),
                            "family": _load_raw_json().get("family", ""),
                            "config": cfg})
            print(f"[bridge] 已导入酒馆主 API（mode=tavern, endpoint={endpoint}, model={model}）", flush=True)
            self._reply_json({"ok": True, "endpoint": endpoint, "model": model, "key_configured": True})
        elif path == "/config/test":
            print("[bridge] config test (GET, 用当前保存配置)", flush=True)
            self._reply_json(_config_test({}))
        elif path == "/enabled":
            st = _load_state()
            self._reply_json({"enabled": st["enabled"]})
        elif path == "/jobs":
            with _job_lock:
                self._reply_json({"jobs": [{k: v for k, v in j.items() if k != "payload"} for j in _jobs][-10:]})
        elif path == "/paths":
            self._reply_json(_paths_state())
        elif path == "/paths/dialog":
            qs = parse_qs(urlparse(self.path).query)
            kind = (qs.get("kind", [""])[0] or "").strip().lower()
            if kind not in ("model", "lora"):
                self._reply_json({"ok": False, "error": "kind 必须是 model 或 lora"}, 400)
                return
            title = "选择模型根目录" if kind == "model" else "选择 LoRA 目录"
            print(f"[bridge] dialog: {kind} 弹窗等待用户选择…", flush=True)
            try:
                picked = _pick_folder_dialog(title)
            except Exception as e:
                print(f"[bridge] dialog ERROR: {e}", flush=True)
                self._reply_json({"ok": False, "error": f"对话框打开失败: {e}"}, 500)
                return
            if not picked:
                print("[bridge] dialog: 用户取消", flush=True)
                self._reply_json({"ok": False, "error": "canceled"})
                return
            print(f"[bridge] dialog picked: {picked}", flush=True)
            self._reply_json({"ok": True, "path": os.path.abspath(picked)})
        else:
            self._reply_json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            data = {}
        if path == "/push":
            if "type" not in data:
                data = {"type": "image", **data}
            if "ts" not in data:
                data["ts"] = time.time()
            broadcast(data)
            print(f"[bridge] pushed: {json.dumps(data, ensure_ascii=False)[:200]}", flush=True)
            self._reply_json({"ok": True})
        elif path == "/prompt":
            system = str(data.get("system", "")).strip()
            try:
                if system:
                    with open(PROMPT_EDIT_FILE, "w", encoding="utf-8") as f:
                        f.write(system)
                else:
                    if os.path.exists(PROMPT_EDIT_FILE):
                        os.unlink(PROMPT_EDIT_FILE)
                self._reply_json({"ok": True, "active": bool(system)})
            except Exception as e:
                self._reply_json({"ok": False, "error": str(e)}, 500)
        elif path == "/models":
            endpoint = str(data.get("endpoint", "")).strip().rstrip("/")
            key = str(data.get("key", "")).strip()
            try:
                req = urllib.request.Request(endpoint + "/models",
                                             headers={"Authorization": "Bearer " + key})
                with urllib.request.urlopen(req, timeout=20) as r:
                    body = json.loads(r.read().decode("utf-8"))
                ids = []
                for it in body.get("data", []) or body.get("models", []):
                    if isinstance(it, dict):
                        ids.append(it.get("id") or it.get("name") or "")
                    elif isinstance(it, str):
                        ids.append(it)
                self._reply_json({"ok": True, "models": [x for x in ids if x][:100]})
            except Exception as e:
                self._reply_json({"ok": False, "error": str(e)[:150]})
        elif path == "/workflow":
            try:
                enabled = bool(data.get("enabled", False))
                wf = data.get("wf", {})
                if not isinstance(wf, dict):
                    self._reply_json({"ok": False, "error": "工作流必须是 JSON 对象（节点字典）"}, 400)
                    return
                with open(WF_CUSTOM_FILE, "w", encoding="utf-8") as f:
                    json.dump({"enabled": enabled, "wf": wf}, f, ensure_ascii=False, indent=2)
                self._reply_json({"ok": True, "enabled": enabled, "nodes": len(wf)})
            except Exception as e:
                self._reply_json({"ok": False, "error": str(e)}, 500)
        elif path == "/cancel":
            _cancel_event.set()
            n = 0
            # 终止正在跑的 gen.py 子进程（若有）
            if _current_proc and _current_proc.poll() is None:
                try:
                    _current_proc.terminate()
                    n += 1
                except Exception:
                    pass
            # 清空 ComfyUI 队列中的 pending 任务 + 中断当前运行
            try:
                cq = _comfy_get("/queue")
                del_ids = [x[1] for x in cq.get("queue_pending", [])]
                if del_ids:
                    _comfy_post("/queue", {"delete": del_ids})
                if cq.get("queue_running"):
                    _comfy_post("/interrupt", {})
                n = len(del_ids) + len(cq.get("queue_running", []))
            except Exception as e:
                print(f"[cancel] ComfyUI 清理失败: {e}", flush=True)
            with _job_lock:
                _last_gen_fp["fp"] = ""
                _last_gen_fp["ts"] = 0.0   # 重置去重（急停后 60s 内可重新触发）
            broadcast({"type": "stage", "stage": "cancel", "msg": "🛑 任务已急停", "ts": time.time()})
            print(f"[cancel] 急停完成（ComfyUI 移除/中断 {n} 个任务）", flush=True)
            self._reply_json({"ok": True, "removed": n})
        elif path == "/generate":
            text = str(data.get("text", "")).strip()
            if len(text) < 10:
                self._reply_json({"ok": False, "error": "text 太短"}, 400)
                return
            # 桥收口去重：同文本指纹 60s 内只接受一次（防前端多触发/双任务）
            fp = _text_fp(text)
            with _job_lock:
                now = time.time()
                if _last_gen_fp["fp"] == fp and now - _last_gen_fp["ts"] < 60:
                    print(f"[gen] 重复触发被拦（60s 窗口内同文本）: {fp}", flush=True)
                    self._reply_json({"ok": False, "dup": True,
                                      "error": "该回复 60 秒内已触发过出图（去重拦截）"}, 429)
                    return
                _last_gen_fp["fp"] = fp
                _last_gen_fp["ts"] = now
            job = {"id": time.strftime("%H%M%S") + "-" + str(int(time.time() * 1000) % 1000),
                   "status": "pending", "created": time.time(), "done": 0,
                   "payload": {"text": text, "model": data.get("model"),
                               "loras": data.get("loras"), "size_mult": data.get("size_mult"),
                               "steps_mult": data.get("steps_mult"), "worldinfo": data.get("worldinfo", ""),
                               "name": data.get("name", "生图")}, "result": {}}
            with _job_lock:
                _jobs.append(job)
            _job_queue.put(job)
            print(f"[gen] job 入队: {job['id']} (text {len(text)} 字)", flush=True)
            self._reply_json({"ok": True, "job": job["id"]}, 202)
        elif path == "/paths":
            model_root = str(data.get("model_root", "")).strip().strip('"')
            lora_dir = str(data.get("lora_dir", "")).strip().strip('"')
            errs = []
            if model_root and not os.path.isdir(model_root):
                errs.append(f"模型根目录不存在: {model_root}")
            if lora_dir and not os.path.isdir(lora_dir):
                errs.append(f"LoRA 目录不存在: {lora_dir}")
            if errs:
                self._reply_json({"ok": False, "error": "；".join(errs)}, 400)
                return
            if not model_root and not lora_dir:
                self._reply_json({"ok": False, "error": "请至少填一个目录"}, 400)
                return
            body = _save_extrapaths(model_root, lora_dir)
            try:
                with open(MODEL_FILE, encoding="utf-8") as f:
                    st = json.load(f)
            except Exception:
                st = {}
            st["extra_dirs"] = {"model_root": model_root, "lora_dir": lora_dir}
            with open(MODEL_FILE, "w", encoding="utf-8") as f:
                json.dump(st, f, ensure_ascii=False, indent=2)
            print(f"[bridge] extra paths saved: root={model_root!r} lora={lora_dir!r}", flush=True)
            self._reply_json({"ok": True, "written": body, "restart_needed": True,
                              "recognized": _recognized()})
        elif path == "/config":
            cfg = dict(_load_raw_json().get("config") or {})
            changed = []
            if "comfy_url" in data:
                url = str(data.get("comfy_url") or "").strip().rstrip("/")
                if url:
                    if not url.startswith(("http://", "https://")):
                        self._reply_json({"ok": False, "error": "comfy_url 必须以 http(s):// 开头"}, 400)
                        return
                    cfg["comfy_url"] = url
                else:
                    cfg.pop("comfy_url", None)      # 空 → 恢复默认
                changed.append("comfy_url")
            if "deepseek_key" in data:
                cfg["deepseek_key"] = str(data.get("deepseek_key") or "").strip()
                changed.append("deepseek_key")
            if "llm" in data and isinstance(data["llm"], dict):
                cur = cfg.get("llm") if isinstance(cfg.get("llm"), dict) else {}
                upd = dict(DEFAULT_LLM)
                upd.update({k: v for k, v in cur.items()
                            if k in ("mode", "endpoint", "key", "model")})
                for k in ("mode", "endpoint", "key", "model"):
                    if k in data["llm"] and data["llm"][k] is not None:
                        upd[k] = str(data["llm"][k]).strip()
                cfg["llm"] = upd                    # mode='tavern' 也照样存
                changed.append("llm")
            raw = _load_raw_json()
            raw["config"] = cfg
            _save_raw_json(raw)
            _auto_models(force=True)                # 地址可能变更 → 清枚举缓存
            print(f"[bridge] config updated: {changed}", flush=True)
            llm = _load_llm()
            self._reply_json({"ok": True, "comfy_url": _comfy(), "llm": {
                "mode": llm.get("mode", "custom"), "endpoint": llm.get("endpoint", ""),
                "model": llm.get("model", ""),
                "key_configured": bool(_load_deepseek_key())},
                "deepseek_configured": bool(_load_deepseek_key())})
        elif path == "/config/test":
            over = data.get("llm") if isinstance(data.get("llm"), dict) else data
            print("[bridge] config test (POST, 覆盖测试不保存)", flush=True)
            self._reply_json(_config_test(over or {}))
        elif path == "/model":
            st = _load_state()
            if "key" in data and data["key"]:
                key = str(data["key"])
                if key in COMPAT:
                    st["key"], st["loras"] = COMPAT[key]
                elif key in MODELS:
                    st["key"] = key
                    st["loras"] = list(MODELS[key]["default_loras"])
                else:
                    self._reply_json({"ok": False, "error": f"unknown model '{key}', options: {list(MODELS)}"}, 400)
                st.pop("auto_model", None)          # 切回固定模型 → 清除自动模型
                st.pop("family", None)
            if "auto_model" in data:
                am = str(data.get("auto_model") or "").strip()
                if not am:
                    st.pop("auto_model", None)      # 空 → 回到静态模板路径
                    st.pop("family", None)
                else:
                    enum = {m["file"] for m in _auto_models(force=True)}
                    if am not in enum:
                        self._reply_json({"ok": False,
                                          "error": f"auto_model '{am}' 不在 ComfyUI 枚举中（检查模型目录）"}, 400)
                        return
                    st["auto_model"] = am
                    st["family"] = wf_builder.detect_family(am)
            allowed = {l["file"] for l in MODELS[st["key"]]["loras"]}
            if "loras" in data and isinstance(data["loras"], list):
                st["loras"] = [x for x in data["loras"] if x in allowed]
            if "size_mult" in data:
                v = data["size_mult"]
                st["size_mult"] = v if v in _VALID_MULTS["size"] else 1.0
            if "steps_mult" in data:
                v = data["steps_mult"]
                st["steps_mult"] = v if v in _VALID_MULTS["steps"] else 1.0
            if "enabled" in data:
                st["enabled"] = bool(data["enabled"])
            if _save_state(st):
                print(f"[bridge] settings -> key={st['key']} loras={st['loras']} "
                      f"size={st['size_mult']}x steps={st['steps_mult']}x", flush=True)
                self._reply_json({"ok": True, **st, "recipe": MODELS.get(st["key"]) or {}})
            else:
                self._reply_json({"ok": False, "error": "save failed"}, 500)
        elif path == "/enabled":
            val = bool(data.get("enabled", data.get("value", False)))
            st = _load_state()
            st["enabled"] = val
            if _save_state(st):
                print(f"[bridge] enabled -> {val}", flush=True)
                self._reply_json({"ok": True, "enabled": val})
            else:
                self._reply_json({"ok": False, "error": "save failed"}, 500)
        else:
            self._reply_json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        pass

    def _serve_events(self):
        q = queue.Queue(maxsize=100)
        with _clients_lock:
            _clients.append((q, threading.Lock()))
        print(f"[bridge] SSE client connected (total={len(_clients)})", flush=True)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            last_heartbeat = time.time()
            while True:
                try:
                    event = q.get(timeout=5)
                    payload = json.dumps(event, ensure_ascii=False)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last_heartbeat = time.time()
                except queue.Empty:
                    if time.time() - last_heartbeat > 15:
                        self.wfile.write(b": hb\n\n")
                        self.wfile.flush()
                        last_heartbeat = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _clients_lock:
                _clients[:] = [(cq, cl) for (cq, cl) in _clients if cq is not q]
            print(f"[bridge] SSE client disconnected (total={len(_clients)})", flush=True)


def _single_instance_guard():
    """单实例排他：8645 已有一个活着的桥 → 本实例直接退出（防双进程双出图）"""
    import socket as _s
    try:
        sk = _s.create_connection((HOST, PORT), timeout=1.0)
        sk.close()
        print(f"[bridge] 检测到 8645 已有实例（或端口被占），本实例退出", flush=True)
        sys.exit(0)
    except OSError:
        pass  # 没人监听 → 正常启动


LOCK_FILE = os.path.join(GEN_DIR, "bridge.lock")


def _acquire_lock():
    """PID 锁文件单实例（比端口探测更可靠：防止 /End 未杀净 + 探测窗口期的双实例）"""
    import atexit
    if os.path.exists(LOCK_FILE):
        try:
            old = int(open(LOCK_FILE, "r").read().strip())
            r = subprocess.run(["tasklist", "/FI", f"PID eq {old}"],
                               capture_output=True, text=True, timeout=10)
            if f"{old}" in (r.stdout or "") and "python" in (r.stdout or "").lower():
                print(f"[bridge] 已有实例（pid={old}）在运行，本实例退出", flush=True)
                sys.exit(0)
        except Exception:
            pass
    with open(LOCK_FILE, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    atexit.register(lambda: os.path.exists(LOCK_FILE) and os.unlink(LOCK_FILE))


def _setup_logging():
    """stdout/stderr 双路：窗口照常显示 + 落盘 bridge.log（崩溃可查）"""
    try:
        f = open(os.path.join(GEN_DIR, "bridge.log"), "a", encoding="utf-8", buffering=1)

        class _Tee:
            def __init__(self, *streams):
                self.streams = streams

            def write(self, s):
                for st in self.streams:
                    try:
                        st.write(s)
                    except Exception:
                        pass
                return len(s)

            def flush(self):
                for st in self.streams:
                    try:
                        st.flush()
                    except Exception:
                        pass

        sys.stdout = _Tee(sys.stdout, f)
        sys.stderr = _Tee(sys.stderr, f)
        print(f"[bridge] 日志已落盘: {os.path.join(GEN_DIR, 'bridge.log')}", flush=True)
    except Exception:
        pass


def main():
    _acquire_lock()
    _setup_logging()
    _single_instance_guard()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    wt = threading.Thread(target=_job_worker, daemon=True)
    wt.start()
    st = _load_state()
    print(f"[bridge] tavern-img-bridge v4 listening on http://{HOST}:{PORT} "
          f"(model={st['key']}, loras={st['loras']}, size={st['size_mult']}x, steps={st['steps_mult']}x, enabled={st['enabled']}, "
          f"comfy={_comfy()}, auto_model={st.get('auto_model') or '-'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
