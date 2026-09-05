#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""publish_image.py — 把 Hermes 生成的图发布到酒馆（拷图 + 推事件给酒馆扩展显示）

用法：
    python publish_image.py --png F:/ComfyUI/ComfyUI/output/xxx.png --prompt "正面词..." [--model unrealvision] [--name 生图]

- 图拷贝到 E:/jiuguan/SillyTavern/public/tavern-img/（酒馆静态目录，方便显示）
- POST http://127.0.0.1:8645/push → 酒馆扩展 SSE 收到 → 图片消息显示在聊天
"""
import argparse
import json
import os
import shutil
import time
import urllib.request

BRIDGE = "http://127.0.0.1:8645/push"
TAVERN_IMG_DIR = r"E:\jiuguan\SillyTavern\public\tavern-img"
TAVERN_BASE = "http://127.0.0.1:8000"


def publish(png_path: str, prompt: str, model: str = "", name: str = "生图"):
    if not os.path.exists(png_path):
        raise FileNotFoundError(png_path)
    os.makedirs(TAVERN_IMG_DIR, exist_ok=True)
    base = os.path.basename(png_path)
    stem, ext = os.path.splitext(base)
    # 文件名规范化：只留字母数字-_（酒馆静态目录，避免中文/特殊字符坑）
    import re
    safe_stem = re.sub(r"[^\w\-]", "_", stem)[-60:] or "img"
    fname = f"{safe_stem}_{int(time.time())}{ext}"
    dest = os.path.join(TAVERN_IMG_DIR, fname)
    shutil.copyfile(png_path, dest)
    url = f"{TAVERN_BASE}/tavern-img/{fname}"
    payload = json.dumps({
        "type": "image",
        "url": url,
        "prompt": prompt,
        "model": model,
        "name": name,
        "ts": time.time(),
    }).encode("utf-8")
    req = urllib.request.Request(BRIDGE, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8")
    print(f"published: {url} -> {body}")
    return url


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", required=True)
    ap.add_argument("--prompt", default="")
    ap.add_argument("--model", default="")
    ap.add_argument("--name", default="生图")
    args = ap.parse_args()
    publish(args.png, args.prompt, args.model, args.name)
