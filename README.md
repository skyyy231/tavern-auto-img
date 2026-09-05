# Tavern Auto Image —— 酒馆自动文生图（扩展 + 可选桥）

角色回复 → 提示词工程 → ComfyUI 出图 → 自动显示在回复下方。

> 本仓库 = **扩展本体 + 桥（可选）+ 安装器**。酒馆 1.12.14+ / Node 22+（酒馆自带，无需 Python）。

## 安装方式（二选一）

### 方式 A：无桥模式（推荐 · 零安装）

酒馆顶部 ⚙ 扩展图标 → **安装扩展** → 粘贴：

```
https://github.com/skyyy231/tavern-auto-img-extension
```

保存后刷新页面，右下角出现 ⚡ 按钮 = 就绪。**开箱即用**：
自动走酒馆内置的 ComfyUI 代理出图（提示词用酒馆主 API，无需任何额外密钥/端口）。

### 方式 B：装桥（增强模式 · 可选项）

装扩展后，扩展目录里自带 `install.bat`（直接双击）：

```
酒馆目录/data/default-user/extensions/tavern-auto-img-extension/install.bat
（若装在全局：酒馆目录/public/scripts/extensions/third-party/tavern-auto-img-extension/install.bat）
```

桥（酒馆服务端插件）带来：自定义工作流 JSON、SSE 阶段提示、出图去重、急停。装一次后**酒馆启动即自动运行**。

> 也支持从 Release 下载一键包：https://github.com/skyyy231/tavern-auto-img/releases

## 日常使用

- ⚡ = 控制台：总开关 / 模型 / LoRA / 速度档位 / 提示词规则 / 工作流模式（自适应·推荐 / 自定义）
- 出图流程：触发后回复下方出现「◌ 正在生成图…」占位卡 → 完成后原地替换成图（无需刷新）
- 模型选择：清单由 ComfyUI 自动枚举，没选模型自动用稳定 SDXL
- 出图失败：阶段提示 + 失败红框 + 停止任务急停

## 卸载

- 方式 A 的卸载：酒馆扩展界面移除扩展即可
- 方式 B：控制台 🧹 一键卸载（或 `install.bat --uninstall`）；扩展保留、配置保留

## 其它

- 完整包（文档/源码归档）：https://github.com/skyyy231/tavern-auto-img
- 换机器：只要装扩展（贴链接）就有基本出图；要高级功能再双击 install.bat
