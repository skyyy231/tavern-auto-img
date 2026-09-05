#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make_recipe_templates.py — 为每个模型生成"模型+配套LoRA"文生图模板（一次性）

原理：读裸模型模板 → 找到 model 源（UNETLoader/CheckpointLoaderSimple）与 clip 源
（CLIPLoader 或 Checkpoint 的 clip 输出，或沿编码节点的 clip 输入链上溯）→
在源后串接 LoraLoader 链 → 下游对源 model/clip 的引用改指最后一级 LoraLoader。
与 tavern_real_femboy_nsfw.json 的做法一致（已验证）。

用法：python make_recipe_templates.py     # 按下方 RECIPES 生成
"""
import json
import shutil
from copy import deepcopy

WORKFLOW_DIR = "F:/ComfyUI/workflows"

# (输出模板名, 源裸模板, [(lora文件, strength_model, strength_clip)], (宽,高,步数,cfg))
RECIPES = [
    ("recipe_unholy_lora.json",   "unholy_Anima29B_文生图.json",
     [("unholyDesire_nsfw_16_5_anima_style.safetensors", 0.8, 0.8)], (768, 1024, 20, 4.0)),
    ("recipe_hassaku_lora.json",  "hassaku_Anima_文生图.json",
     [("hassaku_nsfw_nipple.safetensors", 0.7, 0.7)], (512, 768, 20, 4.0)),
    ("recipe_nova_lora.json",     "nova_Anima_文生图.json",
     [("novaAnime_nsfw_ntr_mix.safetensors", 0.8, 0.8)], (512, 768, 20, 4.0)),
    ("recipe_miaomiao_lora.json", "miaomiao_Anima_文生图.json",
     [("miaomiao_nsfw_habutae_style.safetensors", 0.8, 0.8)], (512, 768, 20, 4.0)),
    ("recipe_kodoranime_lora.json", "kodoranime_文生图.json",
     [("kodoranime_nsfw_nipple_adetailer.safetensors", 0.7, 0.7)], (512, 768, 20, 7.0)),
    ("recipe_gonzalomo_lora.json", "gonzalomo_Krea2_文生图.json",
     [("gonzalomo_nsfw_krea2_nsfw_v4.safetensors", 0.85, 0.85)], (832, 1216, 8, 1.0)),
    ("recipe_moody_lora.json",    "moodyProMix_文生图.json",
     [("moody_nsfw_krea2_mystic_xxx.safetensors", 0.8, 0.8)], (832, 1216, 8, 1.0)),
    ("recipe_flux_lora.json",     "flux1-dev-fp8_文生图.json",
     [("Jib_Flux_Nipple_Fix_v2.safetensors", 0.8, 0.8)], (832, 1216, 20, 1.0)),
    ("recipe_halfreal_lora.json", "unholy_Anima29B_文生图.json",
     [("anima_photorealistic_512-000014.safetensors", 0.8, 0.8),
      ("unholyDesire_sfw_anima_highres.safetensors", 0.5, 0.5)], (832, 1216, 30, 4.0)),
    # 写实无LoRA生成过的再带一个"女角"可选已在 real_beauty；此处补：unrealvision 裸模 + 普通剧情无lora（已 exist）
]


def find_provider(wf, node):
    """追溯 clip 输入源：返回 (model_node_id, clip_node_id, clip_slot) 或 (None,None,None)"""
    ct = node.get("class_type")
    if ct in ("CheckpointLoaderSimple",):
        return None, None, None
    return None, None, None


def build(src_name, out_name, loras, params):
    src = json.load(open(f"{WORKFLOW_DIR}/{src_name}", encoding="utf-8"))
    wf = deepcopy(src)

    # 1) 找 model 源节点
    model_prov = None
    clip_prov = None
    clip_slot = 0
    for nid, n in wf.items():
        ct = n.get("class_type", "")
        if ct in ("CheckpointLoaderSimple", "UNETLoader"):
            model_prov = model_prov or nid
        if ct in ("CLIPLoader", "DualCLIPLoader"):
            clip_prov = clip_prov or nid
        if ct == "CheckpointLoaderSimple" and clip_prov is None:
            pass
    if model_prov is None:
        raise SystemExit(f"{src_name}: no model provider")

    # checkpoint 自带 clip（kodoranime）→ clip 源就是 checkpoint 的 [:1]
    if clip_prov is None and wf[model_prov].get("class_type") == "CheckpointLoaderSimple":
        clip_prov = model_prov
        clip_slot = 1
    if clip_prov is None:
        # 沿编码节点找 clip 输入（CLIPTextEncode/TextEncodeZImageOmni 的 clip 输入源）
        for nid, n in wf.items():
            for k, v in n.get("inputs", {}).items():
                if k == "clip" and isinstance(v, list) and len(v) == 2:
                    pn = v[0]
                    if wf.get(pn, {}).get("class_type") in ("CLIPLoader", "DualCLIPLoader", "CheckpointLoaderSimple"):
                        clip_prov = pn
        if clip_prov is None:
            raise SystemExit(f"{src_name}: no clip provider")

    # 2) 生成 LoraLoader 链
    used_ids = set(wf.keys())
    next_id = max(int(x) for x in used_ids if x.isdigit()) + 1
    chain_model = [model_prov, 0]
    chain_clip = [clip_prov, clip_slot]
    last_lora = None
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
    if last_lora is None:
        raise SystemExit("no loras")

    # 3) 下游引用原 model/clip 源 → 改指最后 LoraLoader；链上 LoraLoader 自身输入一律不动（防循环）
    for nid, n in wf.items():
        if nid in chain_ids:
            continue
        for k, v in n.get("inputs", {}).items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                # model 引用
                if v[0] == model_prov and v[1] == 0 and k in ("model", "clip"):
                    n["inputs"][k] = [last_lora, 0]
                elif v[0] == clip_prov and v[1] == clip_slot and k == "clip":
                    n["inputs"][k] = [last_lora, 1]

    out = f"{WORKFLOW_DIR}/{out_name}"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)
    print(f"[OK] {out_name}  (model+{len(loras)} lora, params {params})")


def apply_params(wf, params):
    # 只回填参数（可选，不用）
    return wf


if __name__ == "__main__":
    for out_name, src_name, loras, params in RECIPES:
        build(src_name, out_name, loras, params)
    print("done.")
