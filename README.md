# Tavern Auto Image（酒馆自动文生图扩展）

酒馆（SillyTavern）角色回复后**自动生成配图**的通用插件：
剧情回复 → 提示词工程器（DeepSeek 等 OpenAI 兼容 API）→ ComfyUI 出图（可本地/可云）→ 图片自动贴在聊天里。

纯 Python 标准库 + 浏览器端 JS，**零第三方依赖**。

## 结构

```
tavern-auto-img-repo/
├── extension/tavern-auto-img/     ← 酒馆扩展（拷贝到 SillyTavern/public/scripts/extensions/third-party/）
│   ├── index.js
│   └── manifest.json
└── bridge/                        ← 中台桥服务（Python 3.10+，无 pip 依赖）
    ├── tavern-img-bridge.py       （启动器：python tavern-img-bridge.py，默认端口 8645）
    ├── gen.py                     （固定配方兜底，可选）
    ├── wf_builder.py              （自动构建器：按模型自动搭工作流，只用 ComfyUI 内置节点）
    ├── publish_image.py           （图片发布到酒馆静态目录）
    └── make_recipe_templates.py   （可选：生成静态配方模板）
```

## 快速开始（3 步）

**① 装酒馆扩展**：把 `extension/tavern-auto-img/` 整个文件夹拷进
`SillyTavern/public/scripts/extensions/third-party/`（没有就创建），重启酒馆 → 扩展设置里出现「Tavern Auto Image」。

**② 搭桥服务**：
1. 把 `bridge/` 放到任意目录（建议 `D:/tavern-auto-img/bridge`）
2. 复制 `config.example.json` 为 `config.json`，按你的机器填 4 项：

```json
{
  "comfy_root": "F:/ComfyUI/ComfyUI",                    // ComfyUI 根目录（云部署可留空）
  "comfy_extra_paths": "F:/ComfyUI/ComfyUI/extra_model_paths.yaml",
  "tavern_img_dir": "E:/jiuguan/SillyTavern/public/tavern-img",   // 酒馆静态目录（图发布到这）
  "tavern_data_dir": "E:/jiuguan/SillyTavern/data/default-user"   // 酒馆 1.18 数据目录（读主 API 用）
}
```
3. 启动：`python tavern-img-bridge.py`（无窗口可用 `pythonw`；登录自启可选）

**③ 在酒馆配置**：
1. 打开扩展面板 → 右下角出现 ⚡ 按钮 → 点开控制台
2. ② ComfyUI 地址填你的地址（本地 `http://127.0.0.1:8188`，云填云端 URL）→ 保存 → 显示「✅ 已连接 节点体检：12/12 就绪」
3. ③ 提示词引擎 API：用酒馆主 API（自动读取，key 不出桥）或切「自定义 API」填 DeepSeek（点「📋 获取模型」选模型）
4. 打开自动文生图开关 → 正常聊天 → 角色回复后自动出图

## 功能

- **自动构建工作流**：模型自动识别家族（anima/krea2/flux/sdxl），只使用 ComfyUI 内置核心节点
- **LoRA 自选**：Family 适配、不兼容标红、可多选叠挂
- **速度档位**：尺寸倍率 × 步数倍率自由组合
- **自定义工作流**：JSON 全权接管（`{prompt}`/`{negative}` 占位符）
- **自定义提示词规则**：面板内直接编辑工程器系统提示词（不用改代码）
- **节点体检**：连接时自动检测 12 个必备节点是否齐全
- **云部署支持**：comfy_url 填云地址即可；输出图自动经 /view 拉回

## 系统要求

- Windows / Linux / macOS（Python 3.10+，标准库）
- ComfyUI（官方原生节点即可，无需第三方节点包）
- 一个 OpenAI 兼容 API（DeepSeek / 任意中转 / 酒馆主 API）

## 常见问题

- **节点体检缺节点？** 缺的均为 ComfyUI 内置节点，说明版本过旧，升级 ComfyUI
- **酒馆主 API 读不到？** 检查 config.json 的 `tavern_data_dir` 是否正确（酒馆 1.18 在 data/default-user）
- **云 ComfyUI？** comfy_root 留空，只需地址；模型清单由云端自动提供
- **无窗口运行？** `pythonw tavern-img-bridge.py`（日志写到 bridge.log）

## 版本与许可

MIT License（自由使用/修改/分发）。本仓库为通用发布版：不含开发者本机配置与私有预设。
