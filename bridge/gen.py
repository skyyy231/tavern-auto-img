#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tavern2img 出图脚本 v2（动态 LoRA + 速度档位）
用法: python gen.py --model unholy --prompt "..." [--negative ...] [--width ... --height ... --seed -1 --steps ... --cfg ... --prefix tavern --save-as ...]
      [--loras "file@0.8,file2@0.5"]   # 动态挂 LoRA（逗号隔开，名字与强度）
      [--size-mult 0.75] [--steps-mult 0.75]  # 速度档位倍率（默认 1.0）
把剧情提示词提交本地 ComfyUI (127.0.0.1:8188), 轮询完成后输出图片绝对路径。
模板位于 F:/ComfyUI/workflows/<model>_文生图.json (API 格式, 已实测)。
"""
import argparse, json, os, random, sys, time, urllib.request, urllib.parse
from copy import deepcopy

SERVER = "http://127.0.0.1:8188"
WORKFLOW_DIR = r"F:/ComfyUI/workflows"

# key -> {"tpl": 模板文件名, "family": 系列, "defaults": {...},
#         "default_loras": [(lora文件, sm, sc), ...]（旧键预置组合，--loras 可覆盖）}
MODEL_MAP = {
    "unholy":    {"tpl": "unholy_Anima29B_文生图.json", "family": "anima", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 4.0}, "default_loras": []},
    "hassaku":   {"tpl": "hassaku_Anima_文生图.json",   "family": "anima", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 4.0}, "default_loras": []},
    "nova":      {"tpl": "nova_Anima_文生图.json",      "family": "anima", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 4.0}, "default_loras": []},
    "miaomiao":  {"tpl": "miaomiao_Anima_文生图.json",  "family": "anima", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 4.0}, "default_loras": []},
    "gonzalomo": {"tpl": "gonzalomo_Krea2_文生图.json", "family": "krea2", "defaults": {"width": 832, "height": 1216, "steps": 8, "cfg": 1.0}, "default_loras": []},
    "kodoranime":{"tpl": "kodoranime_文生图.json",      "family": "sdxl",  "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 7.0}, "default_loras": []},
    "halfreal":  {"tpl": "unholy_Anima29B_文生图.json", "family": "anima", "defaults": {"width": 832, "height": 1216, "steps": 30, "cfg": 4.0},
                  "default_loras": [("anima_photorealistic_512-000014.safetensors", 0.8, 0.8), ("unholyDesire_sfw_anima_highres.safetensors", 0.5, 0.5)]},
    "real":      {"tpl": "tavern_real_nolora.json",     "family": "sdxl",  "defaults": {"width": 832, "height": 1216, "steps": 25, "cfg": 7.0},
                  "default_loras": [("femboysXL_last-000008.safetensors", 0.9, 0.85), ("japanese_girl_v1.1.safetensors", 0.8, 0.75)]},
    # 旧键兼容（预置组合；新调用建议用底模键 + --loras）
    "real_femboy_nsfw": {"tpl": "tavern_real_nolora.json", "family": "sdxl", "defaults": {"width": 832, "height": 1216, "steps": 25, "cfg": 7.0},
                         "default_loras": [("femboysXL_last-000008.safetensors", 0.9, 0.85), ("japanese_girl_v1.1.safetensors", 0.8, 0.75)]},
    "real_beauty": {"tpl": "tavern_real_nolora.json", "family": "sdxl", "defaults": {"width": 832, "height": 1216, "steps": 25, "cfg": 7.0},
                    "default_loras": [("japanese_girl_v1.1.safetensors", 0.8, 0.75)]},
    "real_nolora": {"tpl": "tavern_real_nolora.json", "family": "sdxl", "defaults": {"width": 832, "height": 1216, "steps": 25, "cfg": 7.0}, "default_loras": []},
    "unholy_lora": {"tpl": "unholy_Anima29B_文生图.json", "family": "anima", "defaults": {"width": 768, "height": 1024, "steps": 20, "cfg": 4.0},
                    "default_loras": [("unholyDesire_nsfw_16_5_anima_style.safetensors", 0.8, 0.8)]},
    "hassaku_lora":{"tpl": "hassaku_Anima_文生图.json", "family": "anima", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 4.0},
                    "default_loras": [("hassaku_nsfw_nipple.safetensors", 0.7, 0.7)]},
    "nova_lora":   {"tpl": "nova_Anima_文生图.json", "family": "anima", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 4.0},
                    "default_loras": [("novaAnime_nsfw_ntr_mix.safetensors", 0.8, 0.8)]},
    "miaomiao_lora":{"tpl": "miaomiao_Anima_文生图.json", "family": "anima", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 4.0},
                     "default_loras": [("miaomiao_nsfw_habutae_style.safetensors", 0.8, 0.8)]},
    "kodoranime_lora":{"tpl": "kodoranime_文生图.json", "family": "sdxl", "defaults": {"width": 512, "height": 768, "steps": 20, "cfg": 7.0},
                       "default_loras": [("kodoranime_nsfw_nipple_adetailer.safetensors", 0.7, 0.7)]},
    "gonzalomo_lora":{"tpl": "gonzalomo_Krea2_文生图.json", "family": "krea2", "defaults": {"width": 832, "height": 1216, "steps": 8, "cfg": 1.0},
                      "default_loras": [("gonzalomo_nsfw_krea2_nsfw_v4.safetensors", 0.85, 0.85)]},
    "moody_lora":  {"tpl": "moodyProMix_文生图.json", "family": "krea2", "defaults": {"width": 832, "height": 1216, "steps": 8, "cfg": 1.0},
                    "default_loras": [("moody_nsfw_krea2_mystic_xxx.safetensors", 0.8, 0.8)]},
    "flux_lora":   {"tpl": "flux1-dev-fp8_文生图.json", "family": "flux", "defaults": {"width": 832, "height": 1216, "steps": 20, "cfg": 1.0},
                    "default_loras": [("Jib_Flux_Nipple_Fix_v2.safetensors", 0.8, 0.8)]},
}


def fetch(path):
    with urllib.request.urlopen(SERVER + path, timeout=30) as r:
        return json.loads(r.read().decode())


def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(SERVER + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def object_info(class_type):
    try:
        info = fetch(f"/object_info/{class_type}")
        return info.get(class_type, {})
    except Exception:
        return {}


# 提交前自动校正文件名: 模板里的名字可能在枚举里不存在(下划线/连字符坑), 按 object_info 枚举修正
def fix_names(wf):
    corrected = []
    info = {
        "CheckpointLoaderSimple": ("ckpt_name", object_info("CheckpointLoaderSimple")),
        "UNETLoader": ("unet_name", object_info("UNETLoader")),
        "CLIPLoader": ("clip_name", object_info("CLIPLoader")),
        "VAELoader": ("vae_name", object_info("VAELoader")),
        "LoraLoader": ("lora_name", object_info("LoraLoader")),
    }
    for n in wf.values():
        ct = n.get("class_type", "")
        if ct not in info:
            continue
        field, obj = info[ct]
        inp = n.get("inputs", {})
        val = inp.get(field)
        if not val or not obj:
            continue
        enum = obj.get("input", {}).get("required", {}).get(field, [None])[0]
        if isinstance(enum, list) and val not in enum:
            # 从枚举里找"去掉非字母数字后相同"的候选
            norm = lambda s: "".join(ch for ch in s.lower() if ch.isalnum())
            cand = [e for e in enum if isinstance(e, str) and norm(e) == norm(val)]
            if cand:
                inp[field] = cand[0]
                corrected.append(f"{ct}.{field}: {val} -> {cand[0]}")
    return corrected


def find_providers(wf):
    """找 model 源与 clip 源：返回 (model_prov, clip_prov, clip_slot)"""
    model_prov = clip_prov = None
    clip_slot = 0
    for nid, n in wf.items():
        ct = n.get("class_type", "")
        if ct in ("CheckpointLoaderSimple", "UNETLoader") and model_prov is None:
            model_prov = nid
        if ct in ("CLIPLoader", "DualCLIPLoader") and clip_prov is None:
            clip_prov = nid
    # checkpoint 自带 clip（SDXL）→ clip 源 = checkpoint 的 [:1]
    if clip_prov is None and model_prov and wf[model_prov].get("class_type") == "CheckpointLoaderSimple":
        clip_prov = model_prov
        clip_slot = 1
    if clip_prov is None and model_prov:
        # 沿编码节点找 clip 输入源
        for nid, n in wf.items():
            for k, v in n.get("inputs", {}).items():
                if k == "clip" and isinstance(v, list) and len(v) == 2:
                    pn = v[0]
                    if wf.get(pn, {}).get("class_type") in ("CLIPLoader", "DualCLIPLoader", "CheckpointLoaderSimple"):
                        clip_prov = pn
                        break
    return model_prov, clip_prov, clip_slot


def insert_lora_chain(wf, loras):
    """在 model/clip 源后串接 LoraLoader 链（loras=[(file, sm, sc), ...]），返回 (链上数量, 警告)"""
    if not loras:
        return 0, ""
    model_prov, clip_prov, clip_slot = find_providers(wf)
    if model_prov is None:
        raise SystemExit("模板中找不到 model 源节点（UNETLoader/CheckpointLoaderSimple）")
    if clip_prov is None:
        raise SystemExit("模板中找不到 clip 源节点（CLIPLoader/DualCLIPLoader/Checkpoint）")
    used_ids = set(wf.keys())
    next_id = max(int(x) for x in used_ids if x.isdigit()) + 1
    chain_model = [model_prov, 0]
    chain_clip = [clip_prov, clip_slot]
    last_lora = None
    warn = []
    chain_ids = set()
    for (lora, sm, sc) in loras:
        nid = str(next_id)
        next_id += 1
        chain_ids.add(nid)
        wf[nid] = {
            "class_type": "LoraLoader",
            "inputs": {
                "lora_name": lora,
                "strength_model": sm,
                "strength_clip": sc,
                "model": list(chain_model),
                "clip": list(chain_clip),
            },
            "_meta": {"title": f"Lora {lora}"},
        }
        chain_model = [nid, 0]
        chain_clip = [nid, 1]
        last_lora = nid
    # 下游原引用 → 最后一级 LoraLoader（链上所有 LoraLoader 自身输入一律不动，防循环依赖）
    for nid, n in wf.items():
        if nid in chain_ids:
            continue
        for k, v in n.get("inputs", {}).items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                if v[0] == model_prov and v[1] == 0 and k in ("model", "clip"):
                    n["inputs"][k] = [last_lora, 0]
                elif v[0] == clip_prov and v[1] == clip_slot and k == "clip":
                    n["inputs"][k] = [last_lora, 1]
    return len(loras), "\n".join(warn)


def parse_loras(spec):
    """'file@0.8,file2@0.5' -> [('file', 0.8, 0.8), ('file2', 0.5, 0.5)]；纯文件名不带 @ 用 sm=sc（默认 0.8）"""
    out = []
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        if "@" in part:
            fname, s = part.rsplit("@", 1)
            try:
                sv = float(s)
            except ValueError:
                sv = 0.8
        else:
            fname, sv = part, 0.8
        out.append((fname.strip(), sv, sv))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--negative", default="bad quality, worst quality, lowres, blurry, extra limbs, deformed, text, watermark, jpeg artifacts")
    ap.add_argument("--width", type=int, default=None)
    ap.add_argument("--height", type=int, default=None)
    ap.add_argument("--seed", type=int, default=-1)
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--cfg", type=float, default=None)
    ap.add_argument("--loras", default=None, help="可选: 'file@0.8,file2@0.5' 动态挂 LoRA（覆盖模型默认组合）")
    ap.add_argument("--size-mult", type=float, default=1.0, help="尺寸倍率 0.75/1/1.25")
    ap.add_argument("--steps-mult", type=float, default=1.0, help="步数倍率 0.5/0.75/1/1.5")
    ap.add_argument("--prefix", default="tavern")
    ap.add_argument("--save-as", default=None, help="可选: 完成后再复制一份到指定路径")
    args = ap.parse_args()

    if args.model not in MODEL_MAP:
        sys.exit(f"未知模型 {args.model}, 可选: {list(MODEL_MAP)}")
    info = MODEL_MAP[args.model]
    params = info["defaults"]
    width = args.width if args.width is not None else params.get("width", 512)
    height = args.height if args.height is not None else params.get("height", 768)
    steps = args.steps if args.steps is not None else params.get("steps", 20)
    cfg = args.cfg if args.cfg is not None else params.get("cfg", 4.0)

    # 速度档位换算（宽度/高度取 8 的倍数）
    width = max(64, int(round(width * args.size_mult / 8)) * 8)
    height = max(64, int(round(height * args.size_mult / 8)) * 8)
    steps = max(1, int(round(steps * args.steps_mult)))

    tpl_path = os.path.join(WORKFLOW_DIR, info["tpl"])
    if not os.path.exists(tpl_path):
        sys.exit(f"模板不存在: {tpl_path}")
    with open(tpl_path, encoding="utf-8") as f:
        wf = json.load(f)

    # 动态 LoRA 链：--loras 优先，否则模型默认组合
    loras = parse_loras(args.loras) if args.loras else info["default_loras"]
    if loras:
        n_lora, warn = insert_lora_chain(wf, loras)
        print(f"已挂 LoRA x{n_lora}: {[l[0] for l in loras]}")

    # 找 positive / negative / EmptyLatentImage / KSampler / SaveImage
    nodes = list(wf.values())
    pos_node = neg_node = latent = sampler = save = None
    text_nodes = [n for n in nodes if n.get("class_type") in ("CLIPTextEncode", "TextEncodeZImageOmni")]
    for n in nodes:
        ct = n.get("class_type", "")
        if ct in ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyFluxLatentImage"):
            latent = n
        elif ct == "KSampler":
            sampler = n
        elif ct == "SaveImage":
            save = n
    if text_nodes:
        pos_node = text_nodes[0]
        neg_node = text_nodes[1] if len(text_nodes) > 1 else None
    if neg_node is None:
        clip_src = pos_node["inputs"].get("clip") if pos_node else None
        if pos_node and isinstance(clip_src, list) and len(clip_src) == 2:
            new_id = str(max(int(x) for x in wf.keys() if x.isdigit()) + 1)
            neg_proto = next((n for n in nodes if n.get("class_type") == "CLIPTextEncode"), None)
            if neg_proto is not None:
                neg_node = deepcopy(neg_proto)
                neg_node["inputs"]["clip"] = clip_src
                neg_node["inputs"]["text"] = "(bad quality, worst quality, lowres, blurry)"
                wf[new_id] = neg_node

    if pos_node is None or sampler is None or save is None:
        sys.exit("模板缺少必要节点 (文本编码/KSampler/SaveImage)")
    pos_node["inputs"]["prompt" if pos_node.get("class_type") == "TextEncodeZImageOmni" else "text"] = args.prompt
    if neg_node is not None:
        neg_node["inputs"]["text"] = args.negative
    if latent is not None:
        latent["inputs"]["width"] = width
        latent["inputs"]["height"] = height
    sampler["inputs"]["seed"] = args.seed if args.seed >= 0 else random.randint(0, 2**31 - 1)
    sampler["inputs"]["steps"] = steps
    sampler["inputs"]["cfg"] = cfg
    save["inputs"]["filename_prefix"] = args.prefix

    for msg in fix_names(wf):
        print("自动校正:", msg)

    resp = post("/prompt", {"prompt": wf})
    pid = resp["prompt_id"]
    print(f"已提交: {pid} (seed={sampler['inputs']['seed']}, {width}x{height}, steps={steps}, cfg={cfg})")

    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(3)
        try:
            h = fetch(f"/history/{pid}")
        except Exception:
            continue
        if pid not in h:
            continue
        status = h[pid].get("status", {})
        if status.get("status_str") == "error":
            msgs = status.get("messages", [])
            hint = ""
            for m in msgs:
                if isinstance(m, list) and m and m[0] == "execution_error":
                    hint = json.dumps(m[1], ensure_ascii=False)[:800]
            sys.exit(f"执行出错: {hint or msgs}")
        if status.get("completed", False) or status.get("status_str") == "success":
            outs = h[pid].get("outputs", {})
            img = None
            for node_id, node_out in outs.items():
                for it in node_out.get("images", []):
                    img = it
                    break
                if img:
                    break
            if not img:
                sys.exit("完成但没找到输出图")
            out_path = os.path.join(os.environ.get("TAIMG_COMFY_OUTPUT", "F:/ComfyUI/ComfyUI/output"), img["filename"])
            fallback = os.path.join(os.environ.get("TAIMG_COMFY_OUTPUT", "F:/ComfyUI/ComfyUI/output"), img.get("subfolder", ""), img["filename"]) if img.get("subfolder") else out_path
            print("OK:", fallback)
            if args.save_as:
                import shutil
                dst = args.save_as
                os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
                src_win = fallback.replace("/f/", "F:/").replace("/", "\\")
                shutil.copy2(src_win, dst)
                print("副本:", dst)
            sys.exit(0)
    sys.exit("超时未完成")


if __name__ == "__main__":
    main()
