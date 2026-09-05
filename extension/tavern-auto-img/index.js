// Tavern Auto Image — 酒馆自动文生图显示扩展 v2.0
// ① SSE 订阅 8645：收到"图好了"事件 → 图片作为消息显示在聊天
// ② 设置面板：模型下拉 + LoRA 勾选清单 + 速度档位(尺寸/步数倍率) + 总开关 → POST 8645/model 持久化
import { chat, addOneMessage, saveChatDebounced } from '../../../../script.js';

const BRIDGE = 'http://127.0.0.1:8645';
let eventSource = null;
let connected = false;
// 设置控件引用（buildSettingsUI 里赋值，供事件触发读取当前设置）
let modelSel = null, loraBox = null, sizeSel = null, stepsSel = null, autoModelSel = null;

// 已显示过的图片 url（防重复投递/重复连接导致重复消息）
const shownImages = new Set();

function showImage(data) {
    try {
        const url = data.url || data.image;
        if (!url) return;
        // 三重防重：同 url 已显示 → 跳过（不管谁重复投递）
        if (shownImages.has(url)) return;
        shownImages.add(url);
        // 兜底：chat 里已存在同 url 消息 → 跳过
        const ctx = getCtx();
        if (ctx && ctx.chat && ctx.chat.some(m => m.extra && m.extra.media && m.extra.media.some(x => x.url === url))) return;
        const mes = {
            name: data.name || '生图',
            is_user: false,
            is_system: true,
            mes: '',   // 成功不出文字框：只展示图片本身
            send_date: new Date().toISOString(),
            extra: {
                type: 'image',
                media: [{ url: url, type: 'image', title: data.model || '' }],
                inline_image: true,
            },
        };
        chat.push(mes);
        addOneMessage(mes);
        saveChatDebounced();
        toastr.success('✨ 已生成图片', '自动文生图');  // 右上角轻提示（不是聊天框）
    } catch (err) {
        console.error('[tavern-auto-img] 显示失败:', err);
    }
}

// 失败才需要框框：红色消息 + 提示
function showError(data) {
    const msg = (data && (data.message || data.error)) || '出图失败，请查看桥日志';
    try {
        toastr.error('🛑 ' + msg, '自动文生图');
        const mes = {
            name: '文生图',
            is_user: false,
            is_system: true,
            mes: '🛑 出图失败：' + msg,
            send_date: new Date().toISOString(),
        };
        chat.push(mes);
        addOneMessage(mes);
        saveChatDebounced();
    } catch (e) { console.error('[tavern-auto-img] 错误显示失败:', e); }
}

// ── 独立控制台（右下角 ⚡ 按钮 → 弹层面板）──────────────────
let _panelReady = false;

function ensureOverlay() {
    if ($('#ta-img-ov').length) return;
    const $fab = $('<div id="ta-img-fab" title="自动文生图控制台（可拖动）" style="position:fixed;right:26px;bottom:26px;z-index:9998;width:58px;height:58px;border-radius:50%;background:#2d6cdf;color:#fff;font-size:26px;display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 6px 18px rgba(0,0,0,.5);user-select:none;">⚡</div>');
    // 可拖动：按住移动（移动超过 5px 视为拖拽，不触发点击）+ 位置记忆
    let drag = null;
    let fabMoved = false;   // 独立标志：mouseup 后 250ms 内 click 仍会到，靠它拦截
    $fab.on('mousedown', function (e) {
        const off = $fab.offset();
        drag = { sx: e.clientX, sy: e.clientY, ox: off.left, oy: off.top, moved: false };
        $fab.css('cursor', 'grabbing');
        e.preventDefault();
    });
    $(document).on('mousemove.tafab', function (e) {
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 5) { drag.moved = true; fabMoved = true; }
        if (drag.moved) $fab.css({ left: (drag.ox + dx) + 'px', top: (drag.oy + dy) + 'px', right: 'auto', bottom: 'auto' });
    });
    $(document).on('mouseup.tafab', function () {
        if (drag && drag.moved) {
            const p = $fab.offset();
            localStorage.setItem('ta-img-fab-pos', JSON.stringify({ left: p.left, top: p.top }));
        }
        drag = null;
        $fab.css('cursor', 'grab');
        if (fabMoved) setTimeout(() => { fabMoved = false; }, 250);  // 拦截紧随的 click
    });
    $fab.on('click', function (e) {
        if (fabMoved) return;   // 拖拽结束后的 click 不算
        openPanel();
    });
    try {
        const saved = localStorage.getItem('ta-img-fab-pos');
        if (saved) {
            const p = JSON.parse(saved);
            if (p && p.left != null) $fab.css({ left: p.left + 'px', top: p.top + 'px', right: 'auto', bottom: 'auto' });
        }
    } catch (e) { /* 忽略 */ }
    const $ov = $('<div id="ta-img-ov" style="position:fixed;inset:0;z-index:9999;display:none;background:rgba(0,0,0,.55);align-items:center;justify-content:center;"></div>')
        .on('click', function (e) { if (e.target === this) closePanel(); });
    const $card = $('<div id="ta-img-card" style="width:min(720px,92vw);max-width:calc(100vw - 24px);max-height:calc(100vh - 48px);overflow:auto;background:linear-gradient(165deg,#14151f 0%,#191c2b 55%,#121320 100%);border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:0 0 16px;box-shadow:0 30px 90px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06);"></div>');
    const $head = $('<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,.06);background:linear-gradient(90deg,rgba(129,140,248,.10),rgba(56,189,248,.06));"></div>')
        .append($('<div style="display:flex;align-items:center;gap:12px;"></div>')
            .append('<div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#4158d0,#6a5af9);display:flex;align-items:center;justify-content:center;font-size:23px;box-shadow:0 6px 18px rgba(80,90,220,.45);">⚡</div>')
            .append('<div><div style="font-size:19px;font-weight:700;letter-spacing:.5px;background:linear-gradient(90deg,#818cf8,#38bdf8);-webkit-background-clip:text;background-clip:text;color:transparent;">自动文生图控制台</div><div style="font-size:12px;color:rgba(230,230,242,.55);margin-top:2px;">角色回复 → 提示词 → ComfyUI 出图</div></div>')
            .append('<span id="ta-img-bind" style="display:inline-flex;align-items:center;gap:6px;background:rgba(251,191,36,.10);border:1px solid rgba(251,191,36,.4);color:#fbbf24;font-size:13px;padding:4px 10px;border-radius:999px;">⌛ 联动检测中…</span>'));
    $head.append('<span id="ta-img-open-dir" title="打开扩展文件夹（找桥文件/install.bat）" style="cursor:pointer;font-size:14px;color:#7dd3fc;padding:4px 8px;border-radius:8px;border:1px solid rgba(125,211,252,.35);margin-right:8px;">📂 扩展目录</span>');
    $head.append('<span id="ta-img-close" style="cursor:pointer;font-size:20px;color:#9aa;padding:4px 8px;border-radius:8px;">✕</span>');
    $card.append($head);
    $card.find('#ta-img-close').on('click', closePanel);
    $card.find('#ta-img-open-dir').off('click').on('click', async function () {
        try {
            const r = await fetch(BRIDGE + '/open-dir', { method: 'POST' });
            const d = await r.json();
            if (!d.ok) throw new Error(d.error || '');
            toastr.info('已打开扩展文件夹（若没弹出请检查系统）', '自动文生图');
        } catch (e) {
            toastr.error('无法打开（桥未启动？）——扩展文件夹在：酒馆/data/default-user/extensions/', '自动文生图');
        }
    });
    const $host = $('<div id="ta-img-panel-host" style="display:flex;flex-direction:column;gap:6px;"></div>');
    $card.append($host);
    $ov.append($card);
    // ── 控制台皮肤（渐变玻璃暗色）──
    const TAI_CSS = `
#ta-img-fab{background:linear-gradient(135deg,#4158d0,#6a5af9)!important;box-shadow:0 10px 26px rgba(80,90,220,.45)!important;transition:transform .18s ease,box-shadow .18s ease;}
#ta-img-fab:hover{transform:scale(1.1);box-shadow:0 12px 34px rgba(80,90,220,.6)!important;}
#ta-img-ov{backdrop-filter:blur(6px);}
#ta-img-ov > div{background:linear-gradient(165deg,#14151f 0%,#191c2b 55%,#121320 100%)!important;border:1px solid rgba(255,255,255,.09)!important;border-radius:18px!important;box-shadow:0 30px 90px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06)!important;}
#ta-img-ov .list-group-item{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06);border-radius:12px;margin-bottom:4px;padding:10px 12px;transition:background .15s;}
#ta-img-ov .list-group-item:hover{background:rgba(255,255,255,.055);}
#ta-img-ov select,#ta-img-ov input.text_pole,#ta-img-ov textarea{background:#10121c;border:1px solid rgba(255,255,255,.14);color:#eaeaf3;border-radius:9px;padding:7px 9px;transition:border .15s,box-shadow .15s;}
#ta-img-ov select:focus,#ta-img-ov input.text_pole:focus,#ta-img-ov textarea:focus{border-color:#6a5af9;box-shadow:0 0 0 3px rgba(106,90,249,.25);outline:none;}
#ta-img-ov .menu_button{border-radius:9px;border:1px solid rgba(255,255,255,.12);background:linear-gradient(135deg,#3b3f55,#2a2d40);color:#e8e8f2;box-shadow:0 3px 8px rgba(0,0,0,.35);transition:filter .15s ease,transform .1s;}
#ta-img-ov .menu_button:hover{filter:brightness(1.22);transform:translateY(-1px);}
#ta-img-ov #tavern-img-stop{background:linear-gradient(135deg,#b33434,#7a1f1f)!important;border:none!important;border-radius:9px;}
#ta-img-ov #tavern-img-prompt-save{background:linear-gradient(135deg,#4158d0,#6a5af9)!important;border:none!important;color:#fff;}
#ta-img-ov #tavern-img-loras-pop{background:#171927!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:10px!important;box-shadow:0 14px 40px rgba(0,0,0,.65)!important;}
#ta-img-ov input[type=checkbox]{accent-color:#6a5af9;width:17px;height:17px;}
#ta-img-ov label{color:#e8e8f2;}
#ta-img-ov span.muted{color:rgba(230,230,242,.62)!important;}
#ta-img-ov #ta-img-close:hover{color:#fff;background:rgba(255,255,255,.08);}
#ta-img-ov .fa-wand-magic-sparkles,#ta-img-ov .fa-magic{color:#a78bfa;}
#ta-img-ov .fa-layer-group{color:#67e8f9;}
#ta-img-ov .fa-bolt{color:#fbbf24;}
#ta-img-ov .fa-folder-open,#ta-img-ov .fa-list-check{color:#7dd3fc;}
#ta-img-ov .fa-server{color:#fb923c;}
#ta-img-ov .fa-key{color:#f472b6;}
#ta-img-ov .fa-pen-to-square{color:#34d399;}
#ta-img-ov .fa-power-off{color:#f87171;}
#ta-img-ov .fa-xmark:hover{color:#fff;}
#ta-img-ov #tavern-img-toggle{position:relative;width:48px;height:26px;border-radius:999px;border:none;padding:0;background:#3a3f55;transition:background .18s;cursor:pointer;box-shadow:inset 0 2px 5px rgba(0,0,0,.4);}
#ta-img-ov #tavern-img-toggle::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#cfd2e0;box-shadow:0 2px 6px rgba(0,0,0,.45);transition:left .18s,background .18s;}
#ta-img-ov #tavern-img-toggle.on{background:#6a5af9;box-shadow:0 4px 12px rgba(106,90,249,.45);}
#ta-img-ov #tavern-img-toggle.on::after{left:25px;background:#fff;}
#ta-img-ov #ta-img-bind{background:rgba(139,195,74,.12)!important;border:1px solid rgba(139,195,74,.4)!important;border-radius:999px!important;color:#8bc34a!important;}
`;
    $('body').append($ov, $fab);    $('head').append('<style id=\"ta-img-style\">' + TAI_CSS + '</style>');
    // 把面板内容构建进浮层（只构建一次）
    if (!_panelReady) {
        buildPanelUI($host);
        _panelReady = true;
    }
}

function openPanel() { $('#ta-img-ov').css('display', 'flex'); }
function closePanel() { $('#ta-img-ov').css('display', 'none'); }
$(document).on('keydown.taov', function (e) { if (e.key === 'Escape') { $('#tavern-img-loras-pop').hide(); closePanel(); } });

// ── 设置 UI（ST 扩展设置区只留一个"打开控制台"入口，面板本体在浮层里）──
function buildSettingsUI() {
    const $panel = $('<div></div>');
    const $row = $('<div class="list-group-item flex-container flexGap5" style="align-items:center;flex-wrap:wrap;"></div>')
        .append('<span class="fa-solid fa-bolt" style="margin-right:6px;color:#ffb454;"></span>')
        .append('<button id="tavern-img-openpanel" class="menu_button" style="min-width:180px;font-size:16px;background:#2d6cdf;color:#fff;padding:6px 12px;">⚡ 打开文生图控制台</button>')
        .append('<span class="muted" style="font-size:16px;margin-left:10px;">也会出现在右下角（⚡按钮）</span>');
    $panel.append($row);
    $panel.find('#tavern-img-openpanel').on('click', openPanel);
    return $panel;
}

function buildPanelUI($host) {
    const $panel = $('<div></div>');
    // 触发状态已并入标题行（#ta-img-bind 在控制台标题右侧，省一行空间）
    // 🛑 停止任务（急停）：紧凑一小行（与总开关同排）
    const $stopRow = $('<div class="list-group-item flex-container flexGap5" style="align-items:center;flex-wrap:wrap;padding:6px 10px;"></div>')
        .append('<button id="tavern-img-stop" class="menu_button" title="立即中断正在出图的任务" style="background:#7a1f1f;color:#fff;font-size:15px;padding:4px 12px;white-space:nowrap;min-width:96px;"><span class="fa-solid fa-stop" style="margin-right:5px;"></span>停止任务</button>');
    $panel.append($stopRow);
    $stopRow.find('button').on('click', async function () {
        try {
            const resp = await fetch(BRIDGE + '/cancel', { method: 'POST' });
            const data = await resp.json();
            if (data.ok) toastr.success(`已急停（ComfyUI 移除/中断 ${data.removed || 0} 个任务）`, '自动文生图');
            else toastr.error('急停请求失败', '自动文生图');
        } catch (e) {
            toastr.error('急停失败：' + (e?.message || e), '自动文生图');
        }
    });
    const mkRow = (icon, title) => $('<div class="list-group-item flex-container flexGap5" style="align-items:center;flex-wrap:wrap;"></div>')
        .append(`<span class="fa-solid ${icon}" style="margin-right:6px;"></span><b style="margin-right:8px;">${title}</b>`);

    // ① 模型下拉
    const $rowModel = mkRow('fa-wand-magic-sparkles', '文生图模型：');
    const $select = $('<select id="tavern-img-model" style="max-width:260px;font-size:16px;"><option value="">加载中...</option></select>');
    $rowModel.append($select);
    $panel.append($rowModel);

    // ①b 动态模型（自动发现）：桥从 ComfyUI 枚举的模型清单 auto_models=[{file,family,label}]
    // 桥未实现该字段时整行隐藏（防御，不报错）
    const $rowAuto = mkRow('fa-magic', '④ 模型选择（自动发现）：');
    const $autoSel = $('<select id="tavern-img-automodel" style="max-width:260px;font-size:16px;"><option value="">未选择</option></select>');
    const $autoHint = $('<span class="muted" style="margin-left:6px;font-size:16px;"></span>');
    $rowAuto.append($autoSel, $autoHint);
    $rowAuto.hide();
    $panel.append($rowAuto);

    // ② LoRA 勾选（下拉弹窗多选；可从桥动态拉取，按当前模型家族适配；不兼容红色标注）
    const $rowLora = mkRow('fa-layer-group', '⑤ LoRA 选择（不勾也行，非必须项）：');
    const $btnLoraRefresh = $('<button id="tavern-img-loras-refresh" class="menu_button" style="min-width:70px;white-space:nowrap;">🔄 刷新 LoRA</button>');
    const $loraToggle = $('<button id="tavern-img-loras-open" class="menu_button" style="min-width:170px;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">LoRA：已选 0</button>');
    const $loraPop = $('<div id="tavern-img-loras-pop" style="display:none;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2200;background:#171927;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px 10px;max-height:72vh;overflow-y:auto;width:min(620px,92vw);box-shadow:0 24px 70px rgba(0,0,0,.75);"></div>');
    const $loraBox = $('<div id="tavern-img-loras" style="display:flex;flex-direction:column;gap:2px;"></div>');
    $loraPop.append($loraBox);
    const $loraChips = $('<div id="tavern-img-lora-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;width:100%;"></div>');
    $rowLora.append($loraToggle, $btnLoraRefresh, $loraPop, $loraChips);
    $panel.append($rowLora);

    function updateLoraBadge() {
        const n = $loraBox.find('input[type=checkbox]:checked').length;
        const total = $loraBox.find('input[type=checkbox]').length;
        $loraToggle.text(`LoRA：已选 ${n}/${total}`);
        // 徽章下方显示已选名称（短名 chips）
        const sel = $loraBox.find('input[type=checkbox]:checked');
        $loraChips.empty();
        sel.each(function () {
            const f = this.getAttribute('data-file') || '';
            const short = f.replace(/\.safetensors$/i, '').slice(0, 22);
            $loraChips.append(`<span style="background:#232543;border:1px solid rgba(129,140,248,.45);color:#a5b4fc;border-radius:8px;padding:3px 10px;font-size:13px;">${short}</span>`);
        });
        if ($loraChips.children().length) {
            $loraChips.prepend(`<span style="font-size:13px;color:rgba(230,230,242,.6);align-self:center;">已选：</span>`);
        }
    }

    $loraToggle.on('click', function (e) {
        e.stopPropagation();
        const shown = $loraPop.is(':visible');
        if (shown) { $loraPop.hide(); return; }
        $loraPop.show();
    });
    $(document).off('click.tavernimg').on('click.tavernimg', function (e) {
        if ($loraPop.is(':visible') && !$(e.target).closest('#tavern-img-loras-pop, #tavern-img-loras-open').length) {
            $loraPop.hide();
        }
    });

    // ③ 速度档位（尺寸倍率 + 步数倍率，自由组合）
    const $rowSpeed = mkRow('fa-bolt', '⑥ 速度档位：');
    const $sizeSel = $('<select id="tavern-img-sizemult" style="margin-right:10px;font-size:16px;"></select>');
    const $stepsSel = $('<select id="tavern-img-stepsmult" style="font-size:16px;"></select>');
    const $sizeLab = $('<span class="muted" style="margin-right:6px;">步子×</span>');
    const $stepsLab = $('<span class="muted" style="margin-right:6px;">尺寸×</span>');
    // 顺序：先标尺寸
    $rowSpeed.append($sizeLab, $sizeSel, $stepsLab, $stepsSel);
    $panel.append($rowSpeed);

    // ④ 模型目录自选（extra_model_paths 管理）
    const $rowPaths = mkRow('fa-folder-open', '① 模型 / LoRA 目录（保存后重启 ComfyUI 生效）：');
    const $inRoot = $('<input id="tavern-img-paths-root" class="text_pole" style="flex:1;min-width:120px;font-size:16px;" placeholder="模型根目录，如 D:/模型库">');
    const $inLora = $('<input id="tavern-img-paths-lora" class="text_pole" style="flex:1;min-width:120px;font-size:16px;" placeholder="（可选）LoRA 目录">');
    const $btnPaths = $('<button id="tavern-img-paths-save" class="menu_button" style="min-width:92px;font-size:15px;white-space:nowrap;">💾 保存</button>');
    const $btnRefresh = $('<button id="tavern-img-refresh-list" class="menu_button" style="min-width:92px;font-size:15px;white-space:nowrap;">🔄 刷新</button>');
    const $pathsHint = $('<span class="muted" style="margin-left:6px;font-size:15px;width:100%;"></span>');
    const $pathsCloudHint = $('<span class="muted" style="font-size:14px;width:100%;margin-top:2px;">（云部署的 ComfyUI 无需配置目录：模型清单由云端服务器自动提供）</span>');
    // 目录浏览按钮：调桥 GET /paths/dialog?kind=model|lora（Windows 文件夹选择器），选中即回填输入框
    const mkBrowse = (kind) => $('<button id="tavern-img-browse-' + kind + '" class="menu_button" style="min-width:46px;font-size:15px;white-space:nowrap;" title="选择文件夹">📂</button>').on('click', async function () {
        try {
            const resp = await fetch(`${BRIDGE}/paths/dialog?kind=${kind}`);
            const data = await resp.json();
            if (data.ok && data.path) {
                (kind === 'model' ? $inRoot : $inLora).val(data.path);
            } else {
                toastr.error(data.error || '未选择目录或选择器返回失败', '自动文生图');
            }
        } catch (e) {
            toastr.error('打开目录选择器失败：' + (e?.message || e), '自动文生图');
        }
    });
    // ①+② 三行式：Line1 模型根目录📂 / Line2 LoRA目录📂 / Line3 💾保存+🔄刷新+统计（每行 one-line，不挤不换）
    const $inRootWrap = $('<div style="display:flex;align-items:center;flex-wrap:nowrap;width:100%;margin-top:4px;"></div>');
    const $inLoraWrap = $('<div style="display:flex;align-items:center;flex-wrap:nowrap;width:100%;margin-top:4px;"></div>');
    const $btnsWrap = $('<div style="display:flex;align-items:center;flex-wrap:nowrap;width:100%;margin-top:4px;"></div>');
    $inRootWrap.append($inRoot, mkBrowse('model'));
    $inLoraWrap.append($inLora, mkBrowse('lora'));
    $btnsWrap.append($btnPaths, $btnRefresh);
    $rowPaths.append($inRootWrap, $inLoraWrap, $btnsWrap, $pathsHint, $pathsCloudHint);
    $rowPaths.find('input,button').css('margin-right', '6px');
    $panel.append($rowPaths);

    $btnRefresh.on('click', async function () {
        try {
            const resp = await fetch(BRIDGE + '/model?refresh=1');
            const data = await resp.json();
            if (Array.isArray(data.auto_models) && data.auto_models.length) {
                currentAutoModels = data.auto_models;
                $autoSel.empty().append('<option value="">未选择</option>');
                data.auto_models.forEach(m => {
                    $autoSel.append(`<option value="${m.file}">${m.label || m.file}</option>`);
                });
                $rowAuto.show();
                toastr.success(`已刷新：自动发现模型 ${data.auto_models.length} 个`, '自动文生图');
            } else {
                toastr.warning('刷新完成，但 ComfyUI 未返回模型（检查服务/目录）', '自动文生图');
            }
        } catch (e) {
            toastr.error('刷新失败：' + (e?.message || e), '自动文生图');
        }
    });

    // ⑤ 服务配置：ComfyUI 地址（GET/POST 8645/config）
    const $rowCfg = mkRow('fa-server', '② ComfyUI 地址：');
    const $inComfy = $('<input id="tavern-img-comfy" class="text_pole" style="flex:1;min-width:140px;font-size:16px;" placeholder="ComfyUI 地址，如 http://127.0.0.1:8188">');
    const $btnComfy = $('<button id="tavern-img-comfy-save" class="menu_button" style="min-width:70px;white-space:nowrap;">保存地址</button>');
    const $comfyOk = $('<span class="muted" style="margin-left:8px;font-size:15px;"></span>');
    const $comfyHint = $('<span class="muted" style="font-size:14px;width:100%;margin-top:2px;">（就是你能打开 ComfyUI 的那个网址，浏览器里能打开它就能连）</span>');
    $rowCfg.append($inComfy, $btnComfy, $comfyOk, $comfyHint);
    $panel.append($rowCfg);

    // ⑤b 提示词引擎 API：整齐网格（行1 模式+测试+状态+获取模型；行2 三栏等宽+保存；行3 摘要）
    const $rowLLM = mkRow('fa-key', '③ 提示词引擎 API：');
    const $llmMode = $('<select id="tavern-img-llm-mode" style="min-width:150px;font-size:16px;margin-right:8px;">'
        + '<option value="tavern">用酒馆主 API</option>'
        + '<option value="custom">自定义 API</option>'
        + '</select>');
    const $btnTest = $('<button id="tavern-img-llm-test" class="menu_button" style="min-width:96px;white-space:nowrap;margin-right:8px;">🔌 测试连接</button>');
    const $llmHint = $('<span class="muted" style="margin-right:8px;font-size:15px;"></span>');
    const $btnLlmModels = $('<button id="tavern-img-llm-models-btn" class="menu_button" title="从该 API 获取模型列表" style="min-width:110px;font-size:15px;white-space:nowrap;margin-right:8px;">📋 获取模型</button>');
    $rowLLM.append($llmMode, $btnTest, $llmHint, $btnLlmModels);

    // ⑤c 自定义 API 三栏：Endpoint / API Key / 模型名（等宽 flex:1，整齐对齐）+ 保存
    const $rowCustom = $('<div style="display:flex;align-items:center;margin:6px 0 0 28px;"></div>');
    const $inLlmEndpoint = $('<input id="tavern-img-llm-endpoint" class="text_pole" style="flex:1;min-width:120px;font-size:16px;margin-right:8px;" placeholder="Endpoint，如 https://api.deepseek.com">');
    const $inLlmKey = $('<input id="tavern-img-llm-key" class="text_pole" type="password" style="flex:1;min-width:110px;font-size:16px;margin-right:8px;" placeholder="API Key（存桥本机，不回显）">');
    const $inLlmModel = $('<input id="tavern-img-llm-model" class="text_pole" list="ta-img-llm-models" style="flex:1;min-width:110px;font-size:16px;margin-right:8px;" placeholder="模型名，如 deepseek-chat">');
    const $btnLlmSave = $('<button id="tavern-img-llm-save" class="menu_button" style="min-width:88px;white-space:nowrap;font-size:15px;">💾 保存 API</button>');
    $rowCustom.append($inLlmEndpoint, $inLlmKey, $inLlmModel, $btnLlmSave);
    $rowLLM.append($rowCustom);
    // 模型列表 datalist（原生下拉建议）
    const $dlModels = $('<datalist id="ta-img-llm-models"></datalist>');
    $rowLLM.append($dlModels);
    $btnLlmModels.on('click', async function () {
        const endpoint = ($inLlmEndpoint.val() || '').trim();
        const key = ($inLlmKey.val() || '').trim();
        if (!endpoint) { toastr.error('请先填写 Endpoint', '自动文生图'); return; }
        try {
            $btnLlmModels.prop('disabled', true).text('⏳ 获取中…');
            const resp = await fetch(BRIDGE + '/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: endpoint, key: key }),
            });
            const d = await resp.json();
            if (d.ok && d.models && d.models.length) {
                $dlModels.empty().append(d.models.map(m => `<option value="${m}">`).join(''));
                toastr.success(`已获取 ${d.models.length} 个模型（点模型框选列表）`, '自动文生图');
            } else {
                toastr.error(d.error || '该 API 未返回模型列表', '自动文生图');
            }
        } catch (e) {
            toastr.error('获取模型列表失败：' + (e?.message || e), '自动文生图');
        } finally {
            $btnLlmModels.prop('disabled', false).text('📋 获取模型');
        }
    });

    // ⑤d 酒馆主 API 只读摘要（endpoint/model 展示，key 只显示"已获取"，绝不回显明文）
    const $rowTavern = $('<div style="display:flex;align-items:center;margin:4px 0 0 28px;"></div>');
    const $tavernInfo = $('<span class="muted" style="font-size:15px;"></span>');
    $rowTavern.append($tavernInfo);
    $rowLLM.append($rowTavern);
    $panel.append($rowLLM);

    // ⑥ 提示词规则编辑器 —— 独立弹窗（不再面板内展开）
    const $rowPrompt = mkRow('fa-pen-to-square', '⑦ 提示词规则（编辑后保存，下次出图生效，不用改代码）：');
    const $btnPromptToggle = $('<button id="tavern-img-prompt-toggle" class="menu_button" style="min-width:150px;font-size:16px;white-space:nowrap;">✏️ 编辑提示词规则</button>');
    const $promptStatus = $('<span class="muted" style="margin-left:8px;font-size:16px;"></span>');
    $rowPrompt.append($btnPromptToggle, $promptStatus);
    $panel.append($rowPrompt);

    // 提示词编辑弹窗（fixed 居中；与主控制台独立，互不干扰）
    const $pmOv = $('<div id="ta-img-pm-ov" style="position:fixed;inset:0;z-index:10050;display:none;background:rgba(0,0,0,.6);align-items:center;justify-content:center;"></div>')
        .on('click', function (e) { if (e.target === this) closePromptModal(); });
    const $pmCard = $('<div style="width:min(720px,94vw);max-height:88vh;overflow-y:auto;background:#161724;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:16px 18px;box-shadow:0 30px 90px rgba(0,0,0,.75);"></div>')
        .append($('<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;"><b style="font-size:20px;background:linear-gradient(90deg,#818cf8,#38bdf8);-webkit-background-clip:text;background-clip:text;color:transparent;">✏️ 提示词规则编辑</b><span id="ta-img-pm-close" style="cursor:pointer;font-size:20px;color:#aaa;padding:0 6px;">✕</span></div>'));
    const $taPrompt = $('<textarea id="tavern-img-prompt-ta" style="width:100%;min-height:340px;background:#10121c;color:#eaeaf3;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:10px;font-size:16px;font-family:monospace;resize:vertical;" placeholder="（空=使用工程器默认模板）输入新的系统提示词模板：&#10;&#10;- 可整体替换：直接粘贴你的完整提示词规则&#10;- {family} 占位符可用（被模型族替换）&#10;- 修改后点「💾 保存」即生效（下次出图开始用）"></textarea>');
    const $pmBtnRow = $('<div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:nowrap;"></div>');
    const $btnPromptSave = $('<button id="tavern-img-prompt-save" class="menu_button" style="min-width:100px;font-size:16px;white-space:nowrap;background:linear-gradient(135deg,#4158d0,#6a5af9);color:#fff;padding:8px 16px;">💾 保存</button>');
    const $btnPromptReset = $('<button id="tavern-img-prompt-reset" class="menu_button" style="min-width:110px;font-size:16px;white-space:nowrap;padding:8px 16px;">↺ 恢复默认</button>');
    const $pmStatus = $('<span class="muted" style="margin-left:8px;font-size:15px;"></span>');
    $pmBtnRow.append($btnPromptSave, $btnPromptReset, $pmStatus);
    $pmCard.append($taPrompt, $pmBtnRow);
    $pmOv.append($pmCard);
    $('body').append($pmOv);
    $pmCard.find('#ta-img-pm-close').on('click', closePromptModal);
    function openPromptModal() { loadPrompt(); $('#ta-img-pm-ov').css('display', 'flex'); }
    function closePromptModal() { $('#ta-img-pm-ov').css('display', 'none'); }
    $(document).on('keydown.tapm', function (e) { if (e.key === 'Escape') closePromptModal(); });

    function loadPrompt() {
        fetch(BRIDGE + '/prompt').then(r => r.json()).then(d => {
            if (!d) return;
            $taPrompt.val(d.override || d.system || '');
            $promptStatus.text(d.active ? '（自定义已生效）' : '（默认模板）').css('color', d.active ? '#8bc34a' : '');
            $pmStatus.text(d.active ? '（自定义已生效）' : '（默认模板）').css('color', d.active ? '#8bc34a' : '');
        }).catch(() => {});
    }
    $btnPromptToggle.on('click', openPromptModal);
    $btnPromptSave.on('click', async function () {
        try {
            const resp = await fetch(BRIDGE + '/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ system: $taPrompt.val() }),
            });
            const d = await resp.json();
            if (d.ok) {
                $promptStatus.text(d.active ? '（自定义已生效）' : '（默认模板）').css('color', d.active ? '#8bc34a' : '');
                $pmStatus.text(d.active ? '（自定义已生效）' : '（默认模板）').css('color', d.active ? '#8bc34a' : '');
                toastr.success(d.active ? '提示词规则已保存并生效' : '已恢复默认模板', '自动文生图');
            } else toastr.error(d.error || '保存失败', '自动文生图');
        } catch (e) { toastr.error('保存失败：' + (e?.message || e), '自动文生图'); }
    });
    $btnPromptReset.on('click', async function () {
        try {
            const resp = await fetch(BRIDGE + '/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ system: '' }),
            });
            const d = await resp.json();
            if (d.ok) {
                const g = await (await fetch(BRIDGE + '/prompt')).json();
                $taPrompt.val(g.system || '');
                $promptStatus.text('（默认模板）').css('color', '');
                $pmStatus.text('（默认模板）').css('color', '');
                toastr.success('已恢复默认模板', '自动文生图');
            } else toastr.error(d.error || '恢复失败', '自动文生图');
        } catch (e) { toastr.error('恢复失败：' + (e?.message || e), '自动文生图'); }
    }); 
    loadPrompt();

    // ⑧ 自定义工作流（可选）：粘贴自己 JSON，启用后自动构建器让位
    const $rowWf = mkRow('fa-diagram-project', '⑧ 工作流（可选·自定义）：');
    const $btnWfToggle = $('<button id="tavern-img-wf-toggle" class="menu_button" style="min-width:150px;font-size:16px;white-space:nowrap;">🧩 自定义工作流</button>');
    const $wfStatus = $('<span class="muted" style="margin-left:8px;font-size:15px;"></span>');
    $rowWf.append($btnWfToggle, $wfStatus);
    $panel.append($rowWf);
    const $wfOv = $('<div id="ta-img-wf-ov" style="position:fixed;inset:0;z-index:10060;display:none;background:rgba(0,0,0,.6);align-items:center;justify-content:center;"></div>')
        .on('click', function (e) { if (e.target === this) closeWfModal(); });
    const $wfCard = $('<div style="width:min(820px,94vw);max-height:90vh;overflow-y:auto;background:#161724;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:16px 18px;box-shadow:0 30px 90px rgba(0,0,0,.75);"></div>')
        .append($('<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;"><b style="font-size:20px;background:linear-gradient(90deg,#818cf8,#38bdf8);-webkit-background-clip:text;background-clip:text;color:transparent;">🧩 自定义工作流（JSON）</b><span id="ta-img-wf-close" style="cursor:pointer;font-size:20px;color:#aaa;padding:0 6px;">✕</span></div>')
            .append('<div style="font-size:13px;color:rgba(230,230,242,.6);margin-bottom:8px;">粘贴 <b>API 格式</b>节点图 JSON（ComfyUI 里的「Save (API Format)」）。占位符：<b>{prompt}</b>、<b>{negative}</b> 会被替换为本次提示词（不写则用你写死的文本）。启用后自动构建器让位，模型/参数全由你的 JSON 决定。</div>'));
    const $taWf = $('<textarea id="tavern-img-wf-ta" style="width:100%;min-height:330px;background:#10121c;color:#eaeaf3;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:10px;font-size:14px;font-family:monospace;resize:vertical;" placeholder=\'{"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"模型名"}},...}\'></textarea>');
    const $wfBtnRow = $('<div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:nowrap;"></div>');
    const $wfEn = $('<label style="display:flex;align-items:center;gap:8px;font-size:15px;cursor:pointer;"><input type="checkbox" id="tavern-img-wf-en" style="width:18px;height:18px;">启用自定义工作流（不勾=自动构建）</label>');
    const $btnWfSave = $('<button id="tavern-img-wf-save" class="menu_button" style="min-width:100px;font-size:16px;white-space:nowrap;background:linear-gradient(135deg,#4158d0,#6a5af9);color:#fff;padding:8px 16px;">💾 保存</button>');
    const $btnWfClear = $('<button id="tavern-img-wf-clear" class="menu_button" style="min-width:100px;font-size:16px;white-space:nowrap;padding:8px 16px;">🗑 清空自定义</button>');
    $wfBtnRow.append($wfEn, $btnWfSave, $btnWfClear);
    $wfCard.append($taWf, $wfBtnRow);
    $wfOv.append($wfCard);
    $('body').append($wfOv);
    $wfCard.find('#ta-img-wf-close').on('click', closeWfModal);
    function openWfModal() { loadWf(); $('#ta-img-wf-ov').css('display', 'flex'); }
    function closeWfModal() { $('#ta-img-wf-ov').css('display', 'none'); }
    $(document).on('keydown.tawf', function (e) { if (e.key === 'Escape') closeWfModal(); });

    function loadWf() {
        fetch(BRIDGE + '/workflow').then(r => r.json()).then(d => {
            if (!d) return;
            $taWf.val(d.wf ? JSON.stringify(d.wf, null, 2) : '');
            $wfEn.prop('checked', !!d.enabled);
            $wfStatus.text(d.enabled && d.wf ? '（自定义已启用）' : '（自动构建）').css('color', d.enabled && d.wf ? '#8bc34a' : '');
        }).catch(() => {});
    }
    $btnWfToggle.on('click', openWfModal);
    $btnWfSave.on('click', async function () {
        let wf = {};
        const txt = ($taWf.val() || '').trim();
        if (txt) {
            try { wf = JSON.parse(txt); }
            catch (e) { toastr.error('JSON 格式错误：' + e.message, '自动文生图'); return; }
            if (typeof wf !== 'object' || Array.isArray(wf)) { toastr.error('工作流必须是节点对象（{…}）', '自动文生图'); return; }
        }
        try {
            const resp = await fetch(BRIDGE + '/workflow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: $wfEn.prop('checked'), wf: wf }),
            });
            const d = await resp.json();
            if (d.ok) {
                $wfStatus.text(d.enabled && d.nodes ? '（自定义已启用）' : '（自动构建）').css('color', d.enabled && d.nodes ? '#8bc34a' : '');
                toastr.success($wfEn.prop('checked') && d.nodes ? `自定义工作流已启用（${d.nodes} 节点）` : '已切换为自动构建', '自动文生图');
            } else toastr.error(d.error || '保存失败', '自动文生图');
        } catch (e) { toastr.error('保存失败：' + (e?.message || e), '自动文生图'); }
    });
    $btnWfClear.on('click', async function () {
        $taWf.val(''); $wfEn.prop('checked', false);
        try {
            await fetch(BRIDGE + '/workflow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false, wf: {} }),
            });
            $wfStatus.text('（自动构建）').css('color', '');
            toastr.success('已清空自定义工作流（自动构建）', '自动文生图');
        } catch (e) { toastr.error('清空失败：' + (e?.message || e), '自动文生图'); }
    });
    loadWf();

    // ⑦ 总开关（switch 样式，置于顶部行左侧；停止任务在右侧）
    const $rowBtn = $('<span style="display:inline-flex;align-items:center;gap:8px;margin-right:16px;"></span>')
        .append('<span><span class="fa-solid fa-power-off" style="margin-right:6px;color:#f87171;"></span>自动文生图：</span>');
    const $btn = $('<button id="tavern-img-toggle" class="menu_button" style="font-size:0;"></button>');
    const $swState = $('<span id="ta-img-sw-state" style="font-size:14px;color:#8bc34a;">…</span>');
    $rowBtn.append($btn, $swState);
    $stopRow.prepend($rowBtn);   // 开关在前，停止任务后移

    const SIZE_OPTS = [[1.25, '1.25× 精细'], [1, '1× 标准'], [0.75, '0.75× 快速']];
    const STEPS_OPTS = [[1.5, '1.5× 精细'], [1, '1× 标准'], [0.75, '0.75×'], [0.5, '0.5× 草稿']];
    SIZE_OPTS.forEach(([v, lab]) => $sizeSel.append(`<option value="${v}">${lab}</option>`));
    STEPS_OPTS.forEach(([v, lab]) => $stepsSel.append(`<option value="${v}">${lab}</option>`));

    let currentKey = '';
    let currentAutoModels = [];  // 动态模型清单（桥 /model 返回的 auto_models）
    let currentLoras = [];       // 动态 LoRA 清单（桥 GET /loras 返回 {loras:[{file,family,label,meta_err}]}）
    let currentOptions = {};     // 最近一次 /model 返回的 options 快照（刷新 LoRA/换模型时重渲染用）

    // 读取当前勾选的 LoRA（重渲染时保留用户勾选）
    function readCheckedLoras() {
        return Array.from($loraBox.find('input[type=checkbox]:checked')).map(c => c.getAttribute('data-file'));
    }

    // 拉取桥的动态 LoRA 清单：成功存入 currentLoras 并返回 true；接口 404/异常 → 防御返回 false（不报错）
    async function fetchLoras() {
        try {
            const resp = await fetch(BRIDGE + '/loras');
            if (!resp.ok) return false;
            const data = await resp.json();
            if (data && Array.isArray(data.loras)) {
                currentLoras = data.loras;
                return true;
            }
            return false;
        } catch (e) { /* 防御：桥未实现 /loras 时静默回退 */ }
        return false;
    }

    // 当前选中模型的家族：动态模型优先（currentAutoModels 里选中文件的 family），
    // 其次静态模型 options[key].family；两者都匹配不到 → 返回 null（不筛家族）
    function getCurrentFamily(options, key) {
        const autoFile = $autoSel.val() || '';
        if (autoFile) {
            const autoRec = currentAutoModels.find(m => m.file === autoFile);
            if (autoRec && autoRec.family) return autoRec.family;
        }
        const rec = options[key];
        if (rec && rec.family) return rec.family;
        return null;
    }

    // LoRA 渲染（弹窗内）：候选 = 静态清单 + 动态清单（家族适配分色标注）
    // 兼容 → 正常色；不兼容 → 红色（仍可勾，强制）；家族未知 → 灰色
    function renderLoras(options, key, checkedList) {
        const rec = options[key];
        const staticLoras = (rec && rec.loras) || [];
        const dynamicLoras = Array.isArray(currentLoras) ? currentLoras : [];
        if (!staticLoras.length && !dynamicLoras.length) {
            $loraBox.empty().append('<span class="muted">该模型无可选 LoRA（可点 🔄 刷新 LoRA 重试）</span>');
            updateLoraBadge();
            return;
        }
        const checked = new Set(checkedList || []);
        const curFamily = getCurrentFamily(options, key);
        const items = [];
        const seen = new Set();
        const push = (l) => {
            const file = l.file;
            if (!file || seen.has(file)) return;
            seen.add(file);
            items.push({ file: file, label: l.label || file, family: l.family || null });
        };
        staticLoras.forEach(push);
        dynamicLoras.forEach(push);
        $loraBox.empty();
        items.forEach(l => {
            const incompat = !!(l.family && curFamily && l.family !== curFamily);
            const matched = !!(l.family && curFamily && l.family === curFamily);
            const color = incompat ? '#ff7a7a' : (matched ? '#8ce99a' : '#c8c8c8');
            let lab = l.label;
            if (l.family) lab += `（${l.family}）`;
            const $cb = $('<label style="display:flex;align-items:center;gap:6px;font-size:16px;cursor:pointer;white-space:nowrap;padding:2px 4px;border-radius:4px;"></label>');
            $cb.css('color', color);
            const $input = $('<input type="checkbox" style="width:15px;height:15px;max-width:none;">');
            $input.prop('checked', checked.has(l.file));
            $input.attr('data-file', l.file);
            $cb.append($input).append(`<span style="color:${color};">${lab}${incompat ? '（不兼容?）' : ''}</span>`);
            $loraBox.append($cb);
        });
        updateLoraBadge();
    }

    // 🔄 刷新 LoRA：GET 桥 /loras → currentLoras → 重渲染（保留当前勾选）；失败回退静态清单并温和提示
    $btnLoraRefresh.on('click', async function () {
        const ok = await fetchLoras();
        renderLoras(currentOptions, currentKey, readCheckedLoras());
        if (ok) {
            toastr.success(`已刷新 LoRA：拉取 ${currentLoras.length} 个`, '自动文生图');
        } else {
            toastr.warning('刷新失败（桥未实现 /loras？），已回退静态清单', '自动文生图');
        }
    });

    async function saveSettings() {
        const loras = [];
        $loraBox.find('input[type=checkbox]').each(function () {
            if (this.checked) loras.push(this.getAttribute('data-file'));
        });
        const body = {
            key: $select.val(),
            loras: loras,
            size_mult: parseFloat($sizeSel.val()),
            steps_mult: parseFloat($stepsSel.val()),
        };
        try {
            const resp = await fetch(BRIDGE + '/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (data.ok) { toastr.success('生图设置已保存', '自动文生图'); }
            else { toastr.error(data.error || '保存失败', '自动文生图'); }
        } catch (e) {
            toastr.error('无法保存设置：' + (e?.message || e), '自动文生图');
        }
    }

    async function loadModelOptions() {
        try {
            const resp = await fetch(BRIDGE + '/model');
            if (!resp.ok) return;
            const data = await resp.json();
            const optKeys = Object.keys(data.options || {});
            // 静态预设行默认隐藏：日常用动态模型（自动发现）；静态 8 键参数保留在桥侧 presets 文件
            // 想恢复显示：把下面这行改成 $rowModel.show() 即可
            $rowModel.hide();
            if (optKeys.length) {
                $select.empty();
                optKeys.forEach((key) => {
                    const recipe = data.options[key];
                    $select.append(`<option value="${key}">${recipe.label || key}</option>`);
                });
            }
            currentKey = data.key;
            $select.val(currentKey);
            $sizeSel.val(String(data.size_mult ?? 1));
            $stepsSel.val(String(data.steps_mult ?? 1));
            currentOptions = data.options;  // 快照，供刷新 LoRA/换模型重渲染
            renderLoras(data.options, currentKey, data.loras);
            // 动态模型（自动发现）：桥返回 auto_models=[{file,family,label}] 才渲染该行，否则隐藏（防御）
            const savedAuto = (data.auto_model || '').trim();
            if (Array.isArray(data.auto_models) && data.auto_models.length) {
                currentAutoModels = data.auto_models;
                $autoSel.empty().append('<option value="">未选择</option>');
                data.auto_models.forEach(m => {
                    $autoSel.append(`<option value="${m.file}">${m.label || m.file}</option>`);
                });
                if (savedAuto) {
                    $autoSel.val(savedAuto);
                    const rec = currentAutoModels.find(m => m.file === savedAuto);
                    $autoHint.text(rec ? `家族：${rec.family || '-'} · ${rec.label || rec.file}` : '');
                }
                $rowAuto.show();
            } else {
                currentAutoModels = [];
                $rowAuto.hide();
            }
            $btn.toggleClass('on', data.enabled !== false);
            $swState.text(data.enabled === false ? '关闭' : '开启').css('color', data.enabled === false ? '#8a8f9e' : '#8bc34a');
        } catch (e) {
            $select.empty().append('<option value="">桥接服务未连接</option>');
            $btn.toggleClass('on', false);
            $swState.text('?').css('color', '#8a8f9e');
        }
        // 动态 LoRA：若尚未拉取则自动 GET /loras 一次并重渲染（防御：404/异常静默回退静态，不报错）
        if (!currentLoras.length) {
            const okFetch = await fetchLoras();
            if (okFetch) renderLoras(currentOptions, currentKey, readCheckedLoras());
        }
        // 目录区：回填 + 显示识别统计
        try {
            const pr = await fetch(BRIDGE + '/paths');
            if (pr.ok) {
                const pd = await pr.json();
                if (pd.prefs) {
                    $inRoot.val(pd.prefs.model_root || '');
                    $inLora.val(pd.prefs.lora_dir || '');
                }
                const r = pd.recognized || {};
                const rec = `已识别：模型 ${r.models ?? '-'} · LoRA ${r.loras ?? '-'} · CLIP ${r.clips ?? '-'} · VAE ${r.vaes ?? '-'}`;
                $pathsHint.text(rec + (pd.yaml_exists ? '（extra_model_paths 已配置）' : '（尚未配置自选目录）'));
            }
        } catch (e) { /* 忽略目录区 */ }
    }

    // ── LLM 配置子区：父选项逻辑 ──────────────────────────────
    // 显示/隐藏：酒馆主 API 摘要 vs 自定义 API 三栏
    function setLlmUI(mode) {
        const isTavern = mode === 'tavern';
        $rowCustom.toggle(!isTavern);
        $rowTavern.toggle(isTavern);
        $llmMode.val(isTavern ? 'tavern' : 'custom');
    }

    let currentLlm = { mode: 'custom', endpoint: '', model: '', key_configured: false };

    // 读取酒馆主 API 配置（ST 1.18 正确路线：动态导入 oai_settings + accountStorage）
    // openai.js 同源模块（reverse_proxy 端点 + 模型字段）；密钥经 accountStorage（不落 localStorage）
    async function readTavernApiSettings() {
        try {
            const oaiMod = await import('../../../../scripts/openai.js');
            const accMod = await import('../../../../scripts/util/AccountStorage.js');
            const oai_settings = oaiMod.oai_settings || {};
            const accountStorage = accMod.accountStorage || null;
            const source = oai_settings.chat_completion_source || 'openai';
            const modelKey = `${source}_model`;
            const endpoint = oai_settings.reverse_proxy || oai_settings.custom_url || oai_settings.openai_base_url || '';
            const model = oai_settings[modelKey] || (source === 'custom' ? oai_settings.openai_model : oai_settings.openai_model) || '';
            const key = accountStorage
                ? (accountStorage.getItem('api_key_custom') || accountStorage.getItem('api_key_openai') || '')
                : '';
            return { endpoint, key, model };
        } catch (e) {
            return null;
        }
    }

    // 用酒馆主 API：调桥 /config/tavern（桥读酒馆服务端 settings.json+secrets → 自动导入，key 不出桥）
    async function useTavernApi() {
        try {
            const resp = await fetch(BRIDGE + '/config/tavern');
            const data = await resp.json();
            if (data.ok) {
                setLlmUI('tavern');
                $tavernInfo.html(`Endpoint：${data.endpoint} · 模型：${data.model} · Key：<span style="color:#8bc34a;">✓ 已导入（存桥内）</span>`);
                currentLlm = { mode: 'tavern', endpoint: data.endpoint, model: data.model, key_configured: true };
                toastr.success('已配置为酒馆主 API', '自动文生图');
                $llmHint.text('🔑 已配置').css('color', '#8bc34a');
            } else {
                toastr.error(data.error || '无法读取酒馆 API 配置，请改为自定义 API 并手动填写', '自动文生图');
                setLlmUI('custom');
            }
        } catch (e) {
            toastr.error('无法读取酒馆 API 配置，请改为自定义 API 并手动填写', '自动文生图');
            setLlmUI('custom');
        }
    }

    // 服务配置回填（GET /config）：comfy_url 明文回填；llm.mode 决定父选项；custom 只回填 endpoint/model；key 只显示状态图标
    async function checkComfyStatus() {
        try {
            const r = await fetch(BRIDGE + '/comfycheck');
            const d = await r.json();
            if (!d.ok) {
                $comfyOk.html('<span style="color:#e74c3c;">❌ 未连接</span>');
                return;
            }
            // 连接 OK → 顺带节点体检（工作流所需 12 个节点是否有）
            try {
                const nr = await fetch(BRIDGE + '/nodetest');
                const nd = await nr.json();
                if (nd.ok) {
                    $comfyOk.html(`<span style="color:#8bc34a;">✅ 已连接</span><span style="color:rgba(230,230,242,.65);margin-left:8px;">节点体检：<span style="color:#8bc34a;">${nd.found}/${nd.total} 就绪</span></span>`);
                } else {
                    $comfyOk.html(`<span style="color:#8bc34a;">✅ 已连接</span><span style="color:#e05555;margin-left:8px;">节点缺失：${nd.missing.join(', ')}</span>`);
                }
            } catch (e) {
                $comfyOk.html('<span style="color:#8bc34a;">✅ 已连接</span>');
            }
        } catch (e) {
            $comfyOk.html('<span style="color:#e74c3c;">❌ 未连接</span>');
        }
    }

    async function loadConfig() {
        try {
            const resp = await fetch(BRIDGE + '/config');
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.comfy_url) $inComfy.val(data.comfy_url);
            const llm = data.llm || {};
            const mode = llm.mode === 'tavern' ? 'tavern' : 'custom';
            if (mode === 'tavern') {
                setLlmUI('tavern');
                $tavernInfo.html(`Endpoint：${llm.endpoint || '-'} · 模型：${llm.model || '-'} · Key：<span style="color:#8bc34a;">✓ 已获取</span>`);
            } else {
                setLlmUI('custom');
                $inLlmEndpoint.val(llm.endpoint || '');
                $inLlmModel.val(llm.model || '');   // key 不回填
            }
            currentLlm = { mode: mode, endpoint: llm.endpoint || '', model: llm.model || '', key_configured: !!llm.key_configured };
            const keySet = llm.key_configured !== undefined ? !!llm.key_configured
                : (data.deepseek_configured !== undefined ? !!data.deepseek_configured
                    : (data.deepseek_key_set !== undefined ? !!data.deepseek_key_set
                        : !!(data.deepseek_key && String(data.deepseek_key) !== '')));
            $llmHint.text(keySet ? '🔑 已配置' : '🔑 未配置').css('color', keySet ? '#8bc34a' : '');
        } catch (e) { /* 桥未实现 /config 时忽略 */ }
    }

    $btnPaths.on('click', async function () {
        const body = { model_root: $inRoot.val().trim(), lora_dir: $inLora.val().trim() };
        try {
            const resp = await fetch(BRIDGE + '/paths', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (data.ok) {
                toastr.success('目录已写入 extra_model_paths.yaml，重启 ComfyUI 后生效', '自动文生图');
                const r = data.recognized || {};
                $pathsHint.text(`已识别：模型 ${r.models ?? '-'} · LoRA ${r.loras ?? '-'}（需重启后刷新）`);
            } else {
                toastr.error(data.error || '保存失败', '自动文生图');
            }
        } catch (e) {
            toastr.error('无法保存目录：' + (e?.message || e), '自动文生图');
        }
    });

    // 保存 ComfyUI 地址（POST /config {comfy_url}）
    $btnComfy.on('click', async function () {
        const comfy_url = $inComfy.val().trim();
        try {
            const resp = await fetch(BRIDGE + '/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comfy_url }),
            });
            const data = await resp.json();
            if (data.ok) {
                toastr.success('ComfyUI 地址已保存', '自动文生图');
            } else {
                toastr.error(data.error || '保存失败', '自动文生图');
            }
        } catch (e) {
            toastr.error('无法保存 ComfyUI 地址：' + (e?.message || e), '自动文生图');
        }
    });

    // 父选项切换：用酒馆主 API（读取+保存）/ 自定义 API（展开三栏）
    $llmMode.on('change', function () {
        if ($(this).val() === 'tavern') { useTavernApi(); }
        else { setLlmUI('custom'); }
    });

    // 保存自定义 LLM（POST /config {llm:{mode:'custom',endpoint,key,model}}；成功清空 key 输入框）
    $btnLlmSave.on('click', async function () {
        const endpoint = $inLlmEndpoint.val().trim();
        const key = $inLlmKey.val().trim();
        const model = $inLlmModel.val().trim();
        if (!endpoint || !model) {
            toastr.error('Endpoint 与模型名不能为空', '自动文生图');
            return;
        }
        try {
            const resp = await fetch(BRIDGE + '/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ llm: { mode: 'custom', endpoint: endpoint, key: key, model: model } }),
            });
            const data = await resp.json();
            if (data.ok) {
                $inLlmKey.val('');   // 保存成功清空 key 输入框，不回显
                $llmHint.text(key ? '🔑 已配置' : '🔑 未配置（未填 Key）').css('color', key ? '#8bc34a' : '');
                toastr.success('✓ 已配置', '自动文生图');
                currentLlm = { mode: 'custom', endpoint: endpoint, model: model, key_configured: !!key };
            } else {
                toastr.error(data.error || '保存失败', '自动文生图');
            }
        } catch (e) {
            toastr.error('无法保存自定义 API：' + (e?.message || e), '自动文生图');
        }
    });

    // 🔌 测试连接（GET /config/test，用桥当前配置；返回 {ok, latency_ms|error}）
    $btnTest.on('click', async function () {
        $btnTest.prop('disabled', true).text('测试中…');
        try {
            const resp = await fetch(BRIDGE + '/config/test');
            const data = await resp.json().catch(() => null);
            if (data && data.ok) {
                const txt = data.latency_ms != null ? `✓ 连通 ${data.latency_ms} ms` : '✓ 连通';
                $llmHint.text(txt);
                toastr.success(txt, '自动文生图');
            } else {
                toastr.error((data && data.error) || '连接失败', '自动文生图');
            }
        } catch (e) {
            toastr.error('测试连接失败：' + (e?.message || e), '自动文生图');
        } finally {
            $btnTest.prop('disabled', false).text('🔌 测试连接');
        }
    });

    // 动态模型选中 → 显示 family/label，LoRA 家族适配重渲染，并 POST /model 保存 auto_model（空值=清除）
    $autoSel.on('change', function () {
        const file = $(this).val() || '';
        const rec = currentAutoModels.find(m => m.file === file);
        $autoHint.text(rec ? `家族：${rec.family || '-'} · ${rec.label || rec.file}` : '');
        // 动态模型变更影响 LoRA 家族适配 → 重渲染（保留当前勾选）
        renderLoras(currentOptions, currentKey, readCheckedLoras());
        fetch(BRIDGE + '/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auto_model: file || null }),
        }).then(r => r.json()).then(data => {
            if (data.ok) toastr.success(file ? `动态模型已设为 ${rec?.label || file}` : '动态模型已清除', '自动文生图');
        }).catch(() => { /* 忽略：下次加载回填 */ });
    });

    $select.on('change', function () {
        const key = $(this).val();
        if (!key || key === currentKey) { saveSettings(); return; }
        currentKey = key;
        // 换模型 → 默认勾选该模型 default_loras，再保存
        fetch(BRIDGE + '/model').then(r => r.json()).then(data => {
            const defaults = (data.options[key] && data.options[key].default_loras) || [];
            currentOptions = data.options;  // 快照刷新，供 LoRA 家族适配重渲染
            renderLoras(data.options, key, defaults);
            saveSettings();
        }).catch(() => {});
    });

            $loraBox.on('change', 'input[type=checkbox]', function () { saveSettings(); updateLoraBadge(); });
    $sizeSel.on('change', saveSettings);
    $stepsSel.on('change', saveSettings);

    // 提升为模块级引用（v3 事件触发用）
    modelSel = $select; loraBox = $loraBox; sizeSel = $sizeSel; stepsSel = $stepsSel; autoModelSel = $autoSel;

    $btn.on('click', async function () {
        const turnOn = !$btn.hasClass('on');   // 按当前视觉状态切换（switch 化后按钮无文本，不能再用 text 判断）
        try {
            const resp = await fetch(BRIDGE + '/enabled', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: turnOn }),
            });
            const data = await resp.json();
            if (data.ok) {
                $btn.toggleClass('on', data.enabled);
                $swState.text(data.enabled ? '开启' : '关闭').css('color', data.enabled ? '#8bc34a' : '#8a8f9e');
                toastr.success(data.enabled ? '自动文生图已开启' : '自动文生图已关闭（酒馆只跑剧情不出图）', '自动文生图');
            } else {
                toastr.error(data.error || '操作失败', '自动文生图');
            }
        } catch (e) {
            toastr.error('无法切换：' + (e?.message || e), '自动文生图');
        }
    });

    // 按用户指定顺序重排（DOM 移动，不影响引用）：
    // ①模型/LoRA目录 ②服务配置和API ③模型选择 ④LoRA选择 ⑤速度档位；急停+总开关置顶；提示词规则置底
    [$stopRow, $rowPaths, $rowCfg, $rowLLM, $rowAuto, $rowLora, $rowSpeed, $rowPrompt, $rowWf, $rowModel]
        .forEach(x => { if (x) $panel.append(x); });

    loadModelOptions();
    loadConfig();
    checkComfyStatus();
    $host.append($panel);
    return $panel;
}

// ── SSE 连接 ────────────────────────────────────────────────
function connect() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(BRIDGE + '/events');
    eventSource.onopen = () => {
        connected = true;
        console.log('[tavern-auto-img] 已连接桥接服务', BRIDGE + '/events');
        $('#ta-img-bridge-help').remove();   // 桥活了 → 清除安装引导
    };
    eventSource.onerror = () => {
        if (connected) {
            console.warn('[tavern-auto-img] 连接断开，尝试重连...');
            connected = false;
            showBridgeHelp();
        } else {
            // 从未连接成功 → 桥可能没装/没起：给一键安装引导
            if (!bridgeHelpShown) showBridgeHelp();
        }
    };
    eventSource.onmessage = (evt) => {
        let data;
        try { data = JSON.parse(evt.data); } catch (e) { return; }
        if (data && data.type === 'error') {
            showError(data);
            return;
        }
        if (data && data.type === 'stage') {
            // 阶段提示：提示词生成中 / 开始生图任务 / 重试中 / 已急停
            if (data.stage === 'retry') {
                toastr.warning(data.msg || '出图失败，正在重试…', '自动文生图');
            } else if (data.stage === 'cancel') {
                toastr.warning(data.msg || '任务已急停', '自动文生图');
            } else {
                toastr.info(data.msg || '处理中…', '自动文生图');
            }
            return;
        }
        if (data && (data.type === 'image' || data.url)) {
            showImage(data);
        }
    };
}

// ── 桥未启动引导：控制台顶部显示一键安装 ──
let bridgeHelpShown = false;
function showBridgeHelp() {
    bridgeHelpShown = true;
    const $h = $('#ta-img-bridge-help');
    if (!$h.length) {
        $('<div id="ta-img-bridge-help" style="background:rgba(224,85,85,.10);border:1px solid rgba(224,85,85,.45);border-radius:12px;padding:12px 14px;margin-bottom:10px;font-size:16px;color:#ffb4b4;">' +
          '<div style="font-weight:700;margin-bottom:6px;">⚠️ 桥未启动（出图功能不可用）</div>' +
          '<div style="margin-bottom:8px;line-height:1.7;">桥 = 发动机，随酒馆自动运行。没检测到它可能还没安装：</div>' +
          '<ol style="margin:0 0 8px 18px;line-height:1.7;">' +
          '<li>桥文件已随本扩展下载好了（扩展目录 bridge/ 里）</li>' +
          '<li>打开扩展文件夹里的 <b>install.bat</b> 双击（即本项目仓库根目录，随安装下载的），它会自动：复制桥到 plugins/ + 开开关 + 问你要不要重启酒馆</li>' +
          '<li>完成后强刷本页面，这条提示自动消失</li>' +
          '</ol>' +
          '</div>').insertAfter($('#ta-img-card .list-group-item').first());
    }
}

// ── v3 事件触发：角色回复完成 → 提示词工程 → 出图 ──────────────
const seenMessages = new Set();  // 已触发过（防重）
let autoGenTimer = null;

function getCtx() {
    try { return window.SillyTavern.getContext(); } catch (e) { return null; }
}

async function triggerOnce(msg) {
    const ctx = getCtx();
    // 从 chat 里取当前消息（防重已按 id 处理；用 ctx.chat 找最近一条）
    const isRecent = ctx && ctx.chat && ctx.chat.length && (ctx.chat[ctx.chat.length - 1].id === msg.id);
    // 只处理角色回复：非用户、非系统（我们自己的"已生成图片"就是系统消息）
    if (!isRecent) return;
    if (msg.is_user || msg.is_system) return;
    if (seenMessages.has(msg.id)) return;
    seenMessages.add(msg.id);
    if (seenMessages.size > 100) {
        const first = seenMessages.values().next().value;
        seenMessages.delete(first);
    }
    const text = (msg.mes || msg.message || '').trim();
    if (!text) return;
    console.log('[tavern-auto-img] 收到角色回复, 触发自动文生图, id=', msg.id);
    try {
        const resp = await fetch(BRIDGE + '/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                name: msg.name || '角色',
                model: modelSel?.val() || null,
                auto_model: autoModelSel ? (autoModelSel.val() || null) : null,
                loras: loraBox ? Array.from(loraBox.find('input[type=checkbox]:checked')).map(c => c.getAttribute('data-file')) : null,
                size_mult: sizeSel ? parseFloat(sizeSel.val()) : null,
                steps_mult: stepsSel ? parseFloat(stepsSel.val()) : null,
            }),
        });
        const data = await resp.json();
        if (data.ok) {
            toastr.success('文生图已开始（剧情 → 提示词 → 出图）', '自动文生图');
        } else {
            toastr.error(data.error || '触发失败', '自动文生图');
        }
    } catch (e) {
        console.error('[tavern-auto-img] /generate 调用失败:', e);
        toastr.error('无法连接桥接服务', '自动文生图');
    }
}

function bindMessageEvents() {
    // 重试等待 ST 就绪（getContext 可能未就绪）；绑定后即插即用
    let tries = 0;
    const tryBind = function () {
        const ctx = getCtx();
        if (ctx && ctx.eventSource) {
            ctx.eventSource.on('message_received', function () {
                try {
                    const c = getCtx();
                    if (!c || !c.chat || !c.chat.length) return;
                    const last = c.chat[c.chat.length - 1];
                    if (last && !last.is_user && !last.is_system) {
                        if (autoGenTimer) clearTimeout(autoGenTimer);
                        autoGenTimer = setTimeout(() => triggerOnce(last), 3000);
                        console.log('[tavern-auto-img] message_received, 3s 后触发, id=', last.id);
                    }
                } catch (e) { /* 忽略 */ }
            });
            console.log('[tavern-auto-img] 已绑定 message_received 事件');
            const $bs = $('#ta-img-bind');
            if ($bs.length) {
                $bs.html('<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#8bc34a;box-shadow:0 0 8px #8bc34a;animation:pulse 1.6s infinite;"></span>✅ 已绑定 · 自动出图</span>');
                $bs.css('background', 'rgba(139,195,74,.12)').css('border', '1px solid rgba(139,195,74,.4)').css('color', '#8bc34a');
            }
            toastr.success('事件触发已就绪（角色回复后自动出图）', '自动文生图');
            return true;
        }
        tries++;
        if (tries < 12) {
            setTimeout(tryBind, 500);
            return false;
        }
        const $bs = $('#ta-img-bind');
        if ($bs.length) {
            $bs.text('❌ 未绑定（请刷新重试）').css('background', 'rgba(224,85,85,.10)').css('border', '1px solid rgba(224,85,85,.4)').css('color', '#e05555');
        }
        toastr.error('事件绑定失败：ST 未就绪', '自动文生图');
        return false;
    };
    tryBind();
}

function init() {
    console.log('[tavern-auto-img] 初始化 v3.0...');
    ensureOverlay();          // 右下角 ⚡ + 控制台浮层（面板本体在此）
    buildSettingsUI();        // 设置区只留"打开控制台"入口
    connect();
    setTimeout(bindMessageEvents, 1500);  // 等 ST 就绪再绑
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    window.addEventListener('load', init);
}
