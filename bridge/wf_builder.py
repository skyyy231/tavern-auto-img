#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_builder.py — 通用工作流自动构建器（框架内核，2026-09-04）

思路：给定模型文件名（+家族/可选参数），自动生成 ComfyUI API 格式工作流——
不需要任何手工模板。内置家族识别 + 接线规则（CLIP/VAE/采样器按族匹配），
LoRA 勾选动态插链（链上自身输入不动，防循环依赖）。

只用 ComfyUI 发行版自带节点（CheckpointLoaderSimple/UNETLoader/CLIPLoader/
VAELoader/CLIPTextEncode/KSampler/VAEDecode/SaveImage/EmptyLatentImage/
EmptySD3LatentImage/LoraLoader）。

用法：
    from wf_builder import build_workflow, detect_family
    wf = build_workflow("unholyDesireMixDarkSerenity_v10Anima29B.safetensors",
                        loras=[("unholyDesire_nsfw_16_5_anima_style.safetensors", 0.8, 0.8)],
                        size_mult=1.0, steps_mult=1.0)
"""
import json
import re
import urllib.request, urllib.error

SERVER = "http://127.0.0.1:8188"

# ---- 家族识别（关键词 → 族）----
FAMILY_RULES = [
    (("anima", "unholy", "hassaku", "nova", "miaomiao", "anima29", "turbo"), "anima"),
    (("krea2", "gonzalomo", "moody", "z_image", "zit", "zimage"), "krea2"),
    (("flux", "dev"), "flux"),
    (("kodoranime",), "sdxl"),
]
CHECKPOINT_HINTS = ("kodoranime", "unrealvision", "sdxl", "pony", "illustrious", "anything")

# ---- 族默认配方（接線 + 参数）----
# sampler 名 / CFG / 潜在图类型：anima=SD3 16 通道；sdxl=标准 4 通道；krea2=SD3 16 通道（cfg1）
FAMILY_RECIPES = {
    "anima": {
        "clip": ("qwen_3_06b_base.safetensors", "qwen_image"),
        "vae": "qwen_image-vae.safetensors",
        "latent": ("EmptySD3LatentImage", 16),
        "sampler": "euler", "scheduler": "simple",
        "steps": 20, "cfg": 4.0, "width": 512, "height": 768,
    },
    "krea2": {
        "clip": ("qwen3vl_4b_fp8_scaled.safetensors", "krea2"),
        "vae": "qwen_image-vae.safetensors",
        "latent": ("EmptySD3LatentImage", 16),
        "sampler": "er_sde", "scheduler": "simple",
        "steps": 8, "cfg": 1.0, "width": 832, "height": 1216,
    },
    "flux": {
        "clip": ("t5xxl_fp8_e4m3fn.safetensors",),   # 需 DualCLIPLoader（clip_l + t5）
        "vae": "flux-vae-bf16.safetensors",
        "latent": ("EmptySD3LatentImage", 16),
        "sampler": "euler", "scheduler": "simple",
        "steps": 20, "cfg": 1.0, "width": 832, "height": 1216,
        "dual": True, "clip2": "clip_l.safetensors",
    },
    "sdxl": {
        "checkpoint": True,
        "latent": ("EmptyLatentImage", 4),
        "sampler": "euler", "scheduler": "normal",
        "steps": 20, "cfg": 7.0, "width": 512, "height": 768,
    },
}


def detect_family(model_file: str, model_dir: str = "") -> str:
    """按文件名关键词识别家族；识别不出返回 'unknown'"""
    name = (model_file or "").lower()
    for kws, fam in FAMILY_RULES:
        if any(k in name for k in kws):
            return fam
    if any(k in name for k in CHECKPOINT_HINTS) or model_dir.endswith("checkpoints"):
        return "sdxl"
    # 无特征：unet 目录默认 anima（qwen 系 16ch 最常见），checkpoints 默认 sdxl
    if model_dir.endswith("diffusion_models") or model_dir.endswith("unet"):
        return "anima"
    return "unknown"


def _clip_text_node(nid, clip_ref, text):
    return {
        "class_type": "CLIPTextEncode",
        "inputs": {"clip": clip_ref, "text": text},
        "_meta": {"title": f"CLIPText {nid}"},
    }


# ---- 资源探测：CLIP/VAE/采样器 自动寻找 + 缺失提醒 ----
# 按族的关键词（用于在枚举里"自动寻找"可用的替代项）
FAMILY_FALLBACK = {
    "anima": {"clip_kws": ("qwen_image", "qwen-3-06b", "qwen_3_0", "qwen3_0", "qwen2"), "vae_kws": ("qwen_image", "qwen_image-vae", "qwen"), "scheduler_kws": ("simple", "karras")},
    "krea2": {"clip_kws": ("qwen3vl", "krea2", "qwen2_vl"), "vae_kws": ("qwen_image", "qwen"), "scheduler_kws": ("simple", "karras")},
    "flux": {"clip_kws": ("t5", "flux", "llama"), "vae_kws": ("flux", "ae"), "scheduler_kws": ("simple", "karras")},
    "sdxl": {"clip_kws": (), "vae_kws": (), "scheduler_kws": ("normal", "karras")},
}


def _oi(class_type):
    """object_info 拉取；节点不存在返回 {}"""
    try:
        with urllib.request.urlopen(f"{SERVER}/object_info/{class_type}", timeout=10) as r:
            return json.loads(r.read().decode("utf-8")).get(class_type, {})
    except Exception:
        return {}


def _enum(oi, field):
    """从 object_info 节点定义里取某字段的枚举列表"""
    try:
        v = oi.get("input", {}).get("required", {}).get(field, [None])[0]
        return v if isinstance(v, list) else []
    except Exception:
        return []


def _pick(names, kws, prefer=None, exclude=()):
    """从名字列表里挑选：优先 exact prefer → 关键词命中（按顺序）→ None"""
    if not names:
        return None
    if prefer and prefer in names:
        return prefer
    for kw in kws:
        kw = kw.lower()
        for n in names:
            if kw in n.lower() and n not in exclude:
                return n
    return None


def check_resources(family, model_file=None, verbose=False):
    """校验/寻找本族所需的 CLIP/VAE/采样器/模型文件；
    返回 (ok, resolved, missing)：resolved 为注入配方的覆盖项，missing 为缺失清单"""
    missing = []
    resolved = {}
    rec = FAMILY_RECIPES.get(family)
    if not rec:
        return False, {}, [f"不支持的家族 {family}（可用: anima/krea2/flux/sdxl）"]

    # 0) 节点存在性
    for cls in ("KSampler", "VAEDecode", "SaveImage", "CLIPTextEncode", "LoraLoader"):
        if not _oi(cls):
            missing.append(f"ComfyUI 缺少节点 {cls}")
    lat_cls, lat_ch = rec["latent"]
    if not _oi(lat_cls):
        lat_alt = {"EmptySD3LatentImage": "EmptyLatentImage", "EmptyLatentImage": "EmptySD3LatentImage"}.get(lat_cls)
        if lat_alt and _oi(lat_alt):
            resolved["latent"] = (lat_alt, 4 if lat_alt == "EmptyLatentImage" else lat_ch)
            missing.append(f"缺少 {lat_cls} → 已改用 {lat_alt}（可能与本模型通道不匹配，慎用）")
        else:
            missing.append(f"ComfyUI 缺少 16 通道潜在图节点 {lat_cls}")

    # 1) 模型文件本身
    if model_file:
        if rec.get("checkpoint"):
            names = _enum(_oi("CheckpointLoaderSimple"), "ckpt_name")
            if names and model_file not in names:
                missing.append(f"模型文件不在 ComfyUI 模型目录: {model_file}")
        else:
            names = _enum(_oi("UNETLoader"), "unet_name")
            if names and model_file not in names:
                missing.append(f"模型文件不在 ComfyUI 模型目录: {model_file}")

    # 2) CLIP（checkpoint 自带，跳过）
    if not rec.get("checkpoint"):
        clip_names = _enum(_oi("CLIPLoader"), "clip_name")
        if not clip_names:
            missing.append("CLIPLoader 无可用 CLIP（检查 models/clip 目录）")
        else:
            want = rec["clip"][0] if isinstance(rec.get("clip"), tuple) else None
            got = _pick(clip_names, FAMILY_FALLBACK[family]["clip_kws"], prefer=want)
            if not got:
                missing.append(f"找不到 {family} 族可用 CLIP（枚举: {clip_names[:5]}…）")
            else:
                resolved["clip"] = (got, rec["clip"][1] if isinstance(rec.get("clip"), tuple) else None)

    # 3) VAE（checkpoint 自带，跳过）
    if not rec.get("checkpoint"):
        vae_names = _enum(_oi("VAELoader"), "vae_name")
        if not vae_names:
            missing.append("VAELoader 无可用 VAE（检查 models/vae 目录）")
        else:
            got = _pick(vae_names, FAMILY_FALLBACK[family]["vae_kws"], prefer=rec["vae"])
            if not got:
                missing.append(f"找不到 {family} 族可用 VAE（枚举: {vae_names[:5]}…）")
            else:
                resolved["vae"] = got

    # 4) 采样器
    KSampler = _oi("KSampler")
    if not KSampler:
        missing.append("KSampler 节点不可用")
    else:
        s_enum = _enum(KSampler, "sampler_name")
        if not s_enum:
            missing.append("KSampler 采样器枚举异常")
        else:
            want = rec["sampler"]
            if want not in s_enum:
                # 自动寻找：先按族 scheduler 词、再枚举第一个
                got = _pick(s_enum, (), prefer=None)
                if not got:
                    got = s_enum[0]
                resolved["sampler"] = got
                missing.append(f"采样器 {want} 不存在 → 已改用 {got}")
    return (len([m for m in missing if "→" not in m]) == 0), resolved, missing


def build_workflow(model_file: str, family: str = None, loras=None,
                   size_mult: float = 1.0, steps_mult: float = 1.0,
                   prompt: str = "masterpiece, best quality, 1girl, detailed face",
                   negative: str = "bad quality, worst quality, lowres, blurry") -> dict:
    """自动构建 API 工作流；返回 wf（节点字典）。loras=[(file, sm, sc), ...]
    构建前做资源校验：可替代的自动替代（打印提示），真缺少 → SystemExit 带缺失清单"""
    family = family or detect_family(model_file)
    ok, resolved, missing = check_resources(family, model_file)
    # 输出自动替代/缺失信息
    for m in missing:
        print(f"[wf_builder] {m}")
    hard = [m for m in missing if "→" not in m]
    if hard:
        raise SystemExit("wf_builder 资源缺失:\n- " + "\n- ".join(hard))
    rec = dict(FAMILY_RECIPES[family])
    if resolved.get("clip"):
        rec["clip"] = resolved["clip"]
    if resolved.get("vae"):
        rec["vae"] = resolved["vae"]
    if resolved.get("latent"):
        rec["latent"] = resolved["latent"]
    if resolved.get("sampler"):
        rec["sampler"] = resolved["sampler"]
    if family not in FAMILY_RECIPES:
        raise SystemExit(f"wf_builder: 不支持的家族 {family}（模型 {model_file}）；"
                         "可用: anima/krea2/flux/sdxl")
    rec = FAMILY_RECIPES[family]
    wf = {}
    nid = 1

    def nxt():
        nonlocal nid
        v = str(nid)
        nid += 1
        return v

    if rec.get("checkpoint"):
        model_node = nxt()
        wf[model_node] = {"class_type": "CheckpointLoaderSimple",
                          "inputs": {"ckpt_name": model_file},
                          "_meta": {"title": "Checkpoint"}}
        model_ref = [model_node, 0]
        clip_ref = [model_node, 1]
        vae_ref = [model_node, 2]
    else:
        model_node = nxt()
        wf[model_node] = {"class_type": "UNETLoader",
                          "inputs": {"unet_name": model_file, "weight_dtype": "default"},
                          "_meta": {"title": "UNET"}}
        model_ref = [model_node, 0]
        clip_file, clip_type = rec["clip"]
        if rec.get("dual"):
            clip_node = nxt()
            wf[clip_node] = {"class_type": "DualCLIPLoader",
                             "inputs": {"clip_name1": rec["clip2"], "clip_name2": clip_file,
                                        "type": "flux"},
                             "_meta": {"title": "DualCLIP"}}
        else:
            clip_node = nxt()
            wf[clip_node] = {"class_type": "CLIPLoader",
                             "inputs": {"clip_name": clip_file, "type": clip_type},
                             "_meta": {"title": "CLIP"}}
        vae_node = nxt()
        wf[vae_node] = {"class_type": "VAELoader",
                        "inputs": {"vae_name": rec["vae"]},
                        "_meta": {"title": "VAE"}}
        clip_ref = [clip_node, 0]
        vae_ref = [vae_node, 0]

    lat_type, lat_ch = rec["latent"]
    w = int(round(rec["width"] * size_mult / 8)) * 8
    h = int(round(rec["height"] * size_mult / 8)) * 8
    steps = max(1, int(round(rec["steps"] * steps_mult)))
    latent_node = nxt()
    wf[latent_node] = {"class_type": lat_type,
                       "inputs": {"width": w, "height": h, "batch_size": 1},
                       "_meta": {"title": "Latent"}}
    if lat_type == "EmptySD3LatentImage":
        wf[latent_node]["inputs"]["channels"] = lat_ch
    pos_node = nxt()
    wf[pos_node] = _clip_text_node(pos_node, clip_ref, prompt)
    neg_id = nxt()
    wf[neg_id] = _clip_text_node(neg_id, clip_ref, negative)
    sampler_node = nxt()
    wf[sampler_node] = {"class_type": "KSampler",
                        "inputs": {"model": list(model_ref), "seed": 0, "steps": steps,
                                   "cfg": rec["cfg"], "sampler_name": rec["sampler"],
                                   "scheduler": rec["scheduler"], "denoise": 1.0,
                                   "negative": [neg_id, 0], "positive": [pos_node, 0],
                                   "latent_image": [latent_node, 0]},
                        "_meta": {"title": "KSampler"}}
    decode_node = nxt()
    wf[decode_node] = {"class_type": "VAEDecode",
                       "inputs": {"samples": [sampler_node, 0], "vae": list(vae_ref)},
                       "_meta": {"title": "VAEDecode"}}
    save_node = nxt()
    wf[save_node] = {"class_type": "SaveImage",
                     "inputs": {"images": [decode_node, 0], "filename_prefix": "tavern_auto"},
                     "_meta": {"title": "SaveImage"}}

    # LoRA 链（在 model/clip 源后插；下游引用改指最后一级，链内不动防循环）
    if loras:
        chain_ids = set()
        chain_model = list(model_ref)
        chain_clip = list(clip_ref)
        last = None
        for (lfile, sm, sc) in loras:
            nid_n = nxt()
            chain_ids.add(nid_n)
            wf[nid_n] = {"class_type": "LoraLoader",
                         "inputs": {"lora_name": lfile, "strength_model": sm,
                                    "strength_clip": sc, "model": list(chain_model),
                                    "clip": list(chain_clip)},
                         "_meta": {"title": f"Lora {lfile}"}}
            chain_model = [nid_n, 0]
            chain_clip = [nid_n, 1]
            last = nid_n
        # 下游引用改指最后一级（LoraLoader 自身输入不动）
        for n_id, n in wf.items():
            if n_id in chain_ids:
                continue
            for k, v in n.get("inputs", {}).items():
                if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                    if v[0] == model_ref[0] and v[1] == 0 and k in ("model",):
                        n["inputs"][k] = [last, 0]
                    elif v[0] == clip_ref[0] and v[1] == clip_ref[1] and k == "clip":
                        n["inputs"][k] = [last, 1]
    return wf


if __name__ == "__main__":
    import sys
    import json
    import urllib.request
    f = sys.argv[1] if len(sys.argv) > 1 else "kodoranime_v110.safetensors"
    fam = detect_family(f)
    print(f"模型 {f} → 家族 {fam}")
    # 先演示资源检查（自动寻找 + 缺失提醒）
    ok, resolved, missing = check_resources(fam, f)
    print("资源检查:", "OK" if ok else "有缺失", "| 自动替代:", resolved)
    for m in missing:
        print("  -", m)
    wf = build_workflow(f, prompt="masterpiece, best quality, 1girl, test", negative="bad quality")
    wf[list(wf.keys())[-1]]["inputs"]["filename_prefix"] = "wf_build_smoke"
    for n in wf.values():
        if n.get("class_type") == "KSampler":
            n["inputs"]["steps"] = 8
    resp = json.loads(urllib.request.urlopen(
        urllib.request.Request("http://127.0.0.1:8188/prompt",
                               data=json.dumps({"prompt": wf}).encode(),
                               headers={"Content-Type": "application/json"})).read())
    print("提交 OK:", resp.get("prompt_id"))
