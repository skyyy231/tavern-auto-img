// Tavern Auto Image — 酒馆自动文生图显示扩展 v2.0
// ① SSE 订阅 8645：收到"图好了"事件 → 图片作为消息显示在聊天
// ② 设置面板：模型下拉 + LoRA 勾选清单 + 速度档位(尺寸/步数倍率) + 总开关 → POST 8645/model 持久化
import { chat, addOneMessage, saveChatDebounced, getRequestHeaders, appendMediaToMessage } from '../../../../script.js';
import { saveBase64AsFile } from '../../../utils.js';

const BRIDGE = 'http://127.0.0.1:8645';
let eventSource = null;
let connected = false;
// 设置控件引用（buildSettingsUI 里赋值，供事件触发读取当前设置）
let modelSel = null, loraBox = null, sizeSel = null, stepsSel = null, autoModelSel = null;

// ── 无桥模式本地配置（统一 key 'taImgLocalCfg'）──────────────────
function taGetLocalCfg() {
    try { return JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}') || {}; } catch (e) { return {}; }
}
function taSetLocalCfg(patch) {
    const cur = taGetLocalCfg();
    const next = { ...cur };
    if (patch && typeof patch === 'object') {
        for (const k of Object.keys(patch)) {
            if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) {
                next[k] = { ...cur[k], ...patch[k] };   // 深合并：llm/wf 等子对象不互相覆盖
            } else {
                next[k] = patch[k];
            }
        }
    }
    try { localStorage.setItem('taImgLocalCfg', JSON.stringify(next)); } catch (e) { /* 存储被禁时忽略 */ }
    return next;
}
// 写入我们专属密钥槽（api_key_custom）：写前记录酒馆当前 active 条目 id，写后立即旋转回去——
// 否则 writeSecret 会把 active 抢走，导致酒馆自身聊天（custom 源）Unauthorized
async function writeTaImgSecret(value) {
    let restoreId = '';
    try {
        const s = await fetch('/api/secrets/read', { method: 'POST', headers: getRequestHeaders() });
        const st = await s.json();
        const arr = st && st.api_key_custom;
        if (Array.isArray(arr)) {
            const a = arr.find(x => x && x.active);
            if (a && a.id) restoreId = a.id;
        }
    } catch (e) { /* 读失败则跳过恢复 */ }
    const r = await fetch('/api/secrets/write', {
        method: 'POST', headers: getRequestHeaders(),
        body: JSON.stringify({ key: 'api_key_custom', value: value, label: '自动文生图-自定义API' }),
    });
    const d = await r.json();
    if (restoreId && d && d.id) {
        try { await fetch('/api/secrets/rotate', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ key: 'api_key_custom', id: restoreId }) }); } catch (e) { /* 忽略 */ }
    }
    return d && d.id;
}
// 面板通道状态切换（buildPanelUI 内部赋真实现；默认空实现）
let applyChannelUI = () => {};
// 面板状态整体刷新（通道变化时调用；buildPanelUI 内部赋真实现）
let panelRefreshStatus = () => {};
// 图片附加目标：本次触发的角色消息对象（图挂到它下方，不新增系统消息）；null 时用兜底查找
let pendingImgTarget = null;

// ═══════════ 无桥模式（ST 原生代理，零桥也能出图）═══════════
const TA_ENGINEER_SYSTEM = `你是文生图提示词工程师。用户会给你一段酒馆角色的剧情回复文本，你输出可直接用于 ComfyUI 文生图的英文正向提示词。
规则：
1. 只依据给出的剧情文本构建，文本没写的一律不加（衣服/发色/场景/情绪按原文）。
2. 性别按原文判断：男性/少年 → male 相关词；女性/少女 → female/1girl；不明 → female。
3. 不要输出任何分析、解释、代码块，只输出 JSON。
输出格式：{"positive":"英文提示词,用逗号分隔","male":true或false}`;

const ST_FAMILY_RULES = [
    [['anima', 'unholy', 'hassaku', 'nova', 'miaomiao', 'anima29', 'turbo'], 'anima'],
    [['krea2', 'gonzalomo', 'moody'], 'krea2'],
    [['flux', 'dev', 'z_image', 'zimage', 'zit'], 'flux'],
    [['kodoranime'], 'sdxl'],
];
const ST_CP_HINTS = ['kodoranime', 'unrealvision', 'sdxl', 'pony', 'illustrious', 'anything'];
function stDetectFamily(f) {
    const n = (f || '').toLowerCase();
    for (const [kws, fam] of ST_FAMILY_RULES) if (kws.some(k => n.includes(k))) return fam;
    if (ST_CP_HINTS.some(k => n.includes(k))) return 'sdxl';
    return 'anima';
}
const ST_RECIPES = {
    anima: { clip: ['miaomiaoHarem_anima16_txt.safetensors', 'qwen_image'], vae: 'qwen_image-vae.safetensors', latent: ['EmptySD3LatentImage', 16], sampler: 'euler', scheduler: 'simple', steps: 20, cfg: 4.0, width: 512, height: 768 },
    krea2: { clip: ['gonzalomoKrea2_v40_txt.safetensors', 'krea2'], vae: 'qwen_image-vae.safetensors', latent: ['EmptySD3LatentImage', 16], sampler: 'er_sde', scheduler: 'simple', steps: 8, cfg: 1.0, width: 832, height: 1216 },
    flux: { clip: ['t5xxl_fp8_e4m3fn.safetensors', 'flux'], vae: 'flux-vae-bf16.safetensors', latent: ['EmptySD3LatentImage', 16], sampler: 'euler', scheduler: 'simple', steps: 20, cfg: 1.0, width: 832, height: 1216, dual: true, clip2: 'clip_l.safetensors' },
    sdxl: { checkpoint: true, latent: ['EmptyLatentImage', 4], sampler: 'euler', scheduler: 'normal', steps: 20, cfg: 7.0, width: 512, height: 768 },
};
function stBuildWorkflow(modelFile, family, loras, sizeMult, stepsMult, positive, negative) {
    const rec = ST_RECIPES[family] || ST_RECIPES['anima'];
    let nid = 0;
    const wf = {};
    const nxt = () => String(++nid);
    const clipText = (n, clipRef, text) => { wf[n] = { class_type: 'CLIPTextEncode', inputs: { clip: clipRef, text } }; };
    let modelRef, clipRef, vaeRef;
    if (rec.checkpoint) {
        const n = nxt();
        wf[n] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: modelFile } };
        modelRef = [n, 0]; clipRef = [n, 1]; vaeRef = [n, 2];
    } else {
        const mn = nxt();
        wf[mn] = { class_type: 'UNETLoader', inputs: { unet_name: modelFile, weight_dtype: 'default' } };
        modelRef = [mn, 0];
        const cn = nxt();
        if (rec.dual) {
            wf[cn] = { class_type: 'DualCLIPLoader', inputs: { clip_name1: rec.clip2, clip_name2: rec.clip[0], type: 'flux' } };
        } else {
            wf[cn] = { class_type: 'CLIPLoader', inputs: { clip_name: rec.clip[0], type: rec.clip[1] || 'flux' } };
        }
        clipRef = [cn, 0];
        const vn = nxt();
        wf[vn] = { class_type: 'VAELoader', inputs: { vae_name: rec.vae } };
        vaeRef = [vn, 0];
    }
    const w = Math.round(rec.width * sizeMult / 8) * 8;
    const h = Math.round(rec.height * sizeMult / 8) * 8;
    const steps = Math.max(1, Math.round(rec.steps * stepsMult));
    const ln = nxt();
    wf[ln] = { class_type: rec.latent[0], inputs: rec.latent[0] === 'EmptySD3LatentImage' ? { width: w, height: h, batch_size: 1, channels: rec.latent[1] } : { width: w, height: h, batch_size: 1 } };
    const pn = nxt(); clipText(pn, clipRef, positive);
    const nn = nxt(); clipText(nn, clipRef, negative);
    const sn = nxt();
    wf[sn] = { class_type: 'KSampler', inputs: { model: modelRef, seed: Math.floor(Math.random() * 2 ** 31), steps, cfg: rec.cfg, sampler_name: rec.sampler, scheduler: rec.scheduler, denoise: 1.0, negative: [nn, 0], positive: [pn, 0], latent_image: [ln, 0] } };
    const dn = nxt();
    wf[dn] = { class_type: 'VAEDecode', inputs: { samples: [sn, 0], vae: vaeRef } };
    const fnn = nxt();
    wf[fnn] = { class_type: 'SaveImage', inputs: { images: [dn, 0], filename_prefix: 'tavern_auto' } };
    if (loras && loras.length) {
        let cm = modelRef, cc = clipRef;
        for (const [lf, sm, sc] of loras) {
            const ln2 = nxt();
            wf[ln2] = { class_type: 'LoraLoader', inputs: { lora_name: lf, strength_model: sm, strength_clip: sc, model: cm, clip: cc } };
            cm = [ln2, 0]; cc = [ln2, 1];
        }
        wf[sn].inputs.model = cm;
    }
    return wf;
}

let stAbort = null;  // 无桥模式中断信号

/** 无桥模式：提示词工程器（走酒馆主 API 代理，同源无密钥） */
async function stEngineer(text, family) {
    const llmCfg = taGetLocalCfg().llm || {};
    const llmEndpoint = (document.getElementById('tavern-img-llm-endpoint')?.value || '').trim() || llmCfg.endpoint || 'http://127.0.0.1:18789/v1';
    const llmModel = (document.getElementById('tavern-img-llm-model')?.value || '').trim() || llmCfg.model || 'openclaw/tavern';
    // 提示词规则：无桥本地 prompt_edit 非空时覆盖默认工程器模板（{family} 占位符保留）
    let stSys = TA_ENGINEER_SYSTEM;
    try { const pe = (taGetLocalCfg().prompt_edit || '').trim(); if (pe) stSys = pe; } catch (e) { /* 忽略 */ }
    const body = {
        messages: [
            { role: 'system', content: stSys.replace('{family}', family) },
            { role: 'user', content: `模型族：${family}\n剧情回复文本：\n${(text || '').slice(0, 6000)}` },
        ],
        chat_completion_source: 'custom',
        custom_url: llmEndpoint,
        model: llmModel,
        max_tokens: 1200,
        temperature: 0.8,
        stream: false,
    };
    // 面板里填过自定义 key → 用酒馆密钥库独立槽（secret_id），与酒馆自身 API 互不干扰
    try { const sid = (llmCfg.secretId || '').trim(); if (sid) body.secret_id = sid; } catch (e) { /* 忽略 */ }
    const r = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        signal: stAbort ? stAbort.signal : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(String(j?.error?.message || 'LLM 调用失败 ' + r.status));
    const content = j?.choices?.[0]?.message?.content || '';
    try {
        const m = content.match(/\{[\s\S]*\}/);
        const p = JSON.parse(m ? m[0] : content);
        return { positive: String(p.positive || p.prompt || '').trim(), male: !!p.male };
    } catch (e) {
        return { positive: content.trim().replace(/^["'`]+|["'`]+$/g, ''), male: false };
    }
}

/** 无桥模式：自定义工作流占位符替换（遍历节点，把 {prompt}/{negative} 换成本次提示词） */
function applyWfCustom(wf, positive, negative) {
    const deep = (v) => {
        if (typeof v === 'string') return v.replace(/\{prompt\}/g, () => positive).replace(/\{negative\}/g, () => negative);
        if (Array.isArray(v)) return v.map(deep);
        if (v && typeof v === 'object') {
            const o = {};
            for (const k of Object.keys(v)) o[k] = deep(v[k]);
            return o;
        }
        return v;
    };
    return deep(wf);
}

/** 无桥前置体检：节点齐不齐 + 家族依赖的 CLIP/VAE 在不在（直连 object_info，CORS 已开） */
async function stPreflight(family, comfyUrl) {
    const need = new Set(['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'DualCLIPLoader', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage', 'EmptyLatentImage', 'EmptySD3LatentImage', 'VAELoader', 'LoraLoader']);
    const rec = ST_RECIPES[family] || ST_RECIPES['anima'];
    const r = await fetch(`${comfyUrl}/object_info`);
    if (!r.ok) throw new Error('无法读取 ComfyUI 节点信息（' + r.status + '）');
    const oi = await r.json();
    const missing = [...need].filter(n => !oi[n]);
    if (missing.length) throw new Error(`ComfyUI 缺少节点：${missing.join('、')}（请安装对应节点包）`);
    const needClip = rec.checkpoint ? [] : (rec.dual ? [rec.clip2, rec.clip[0]] : [rec.clip[0]]);
    const clips = (oi['CLIPLoader']?.input?.required?.clip_name?.[0] || oi['CLIPLoader']?.input?.required?.clip_name?.[1]?.options || []);
    const vaes = (oi['VAELoader']?.input?.required?.vae_name?.[0] || oi['VAELoader']?.input?.required?.vae_name?.[1]?.options || []);
    const missFiles = [...needClip.filter(c => !clips.includes(c)), ...((!rec.checkpoint && !vaes.includes(rec.vae)) ? [rec.vae] : [])];
    if (missFiles.length) throw new Error(`模型族「${family}」缺依赖文件：${missFiles.join('、')}（放入 ComfyUI models/text_encoders 或 models/vae）`);
}

/** 无桥模式：全链出图（工程器 → 工作流 → ST 代理 → 存文件 → 嵌入聊天） */
async function generateViaST(text, name) {
    console.log('[ta-img][st] ① 进入无桥出图', { textLen: (text || '').length, name });
    const localCfg = taGetLocalCfg();
    let modelFile = (autoModelSel?.val() || '').trim() || (modelSel?.val() || '').trim();
    if (!modelFile) modelFile = (localCfg.auto_model || '').trim();   // 面板未加载时从本地兜底
    const family = modelFile ? stDetectFamily(modelFile) : 'anima';
    // LoRA：面板勾选优先；无勾选时用无桥手动清单（localStorage）
    let loras = loraBox ? Array.from(loraBox.find('input[type=checkbox]:checked')).map(c => c.getAttribute('data-file') || '') : [];
    if (!loras.length && Array.isArray(localCfg.loras)) loras = localCfg.loras;
    const fNum = (s, d) => { const n = parseFloat(s); return isFinite(n) ? n : d; };
    const sizeMult = fNum(sizeSel?.val(), fNum(String(localCfg.size_mult ?? ''), 1));
    const stepsMult = fNum(stepsSel?.val(), fNum(String(localCfg.steps_mult ?? ''), 1));
    let comfyUrl = (document.getElementById('tavern-img-comfy')?.value || '').trim() || (localCfg.comfy_url || '').trim() || 'http://127.0.0.1:8188';
    comfyUrl = comfyUrl.replace(/\/+$/, '');

    toastr.info('🤖 提示词生成中…（无桥模式·走酒馆主 API）', '自动文生图');
    const pr = await stEngineer(text, family).catch(e => { throw new Error('提示词生成失败:' + e.message); });
    const negative = 'bad quality, worst quality, lowres, blurry, extra limbs, deformed hands, text, watermark'
        + (pr.male ? ', female, woman, girl, big breasts, cleavage, westerner, caucasian' : '');
    toastr.info('✅ 提示词完成，开始生图…', '自动文生图');

    // 自定义工作流优先：已启用且粘贴了 API JSON → 替换占位符后直接用（模型/参数由 JSON 决定）
    const wfCfg = localCfg.wf || {};
    const useCustomWf = !!(wfCfg.enabled && wfCfg.wf && typeof wfCfg.wf === 'object' && !Array.isArray(wfCfg.wf) && Object.keys(wfCfg.wf).length);
    if (!useCustomWf && !modelFile) throw new Error('未选择模型（在控制台④ 模型选择里挑一个）');
    if (!useCustomWf) await stPreflight(family, comfyUrl);   // 自适应模式：节点+CLIP/VAE 前置体检
    const lorasArr = loras.map(f => [f, 0.8, 0.8]);
    const wf = useCustomWf
        ? applyWfCustom(wfCfg.wf, pr.positive, negative)
        : stBuildWorkflow(modelFile, family, lorasArr, sizeMult, stepsMult, pr.positive, negative);

    stAbort = new AbortController();
    const r = await fetch('/api/sd/comfy/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url: comfyUrl, prompt: '{ "prompt": ' + JSON.stringify(wf) + ' }' }),
        signal: stAbort.signal,
    });
    console.log('[ta-img][st] ⑤ 代理返回', r.status);
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error('ComfyUI(代理) 失败: ' + t.slice(0, 200));
    }
    const result = await r.json();
    if (!result.data) throw new Error('ComfyUI 未返回图片数据');
    console.log('[ta-img][st] ⑥ 拿到 base64，上传中…', result.format);
    const fmt = (result.format || 'png').toLowerCase();
    const fname = 'tavern_auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const url = await saveBase64AsFile(result.data, (name || '生图').replace(/[\\/]/g, '_'), fname, fmt);
    console.log('[ta-img][st] ⑦ 上传成功，url =', url);
    showImage({ url: url, name: name, model: modelFile });
    console.log('[ta-img][st] ⑧ showImage 调用完成');
    return url;
}

/** 通道探测：桥活着？返回 'bridge'；ST 代理可用？返回 'st'；全无 → 'none' */
async function detectChannel() {
    if (connected) return 'bridge';
    try {
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 2000);
        const r = await fetch('/api/sd/comfy/ping', {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify({ url: (document.getElementById('tavern-img-comfy')?.value || 'http://127.0.0.1:8188').trim() }),
            signal: ctl.signal,
        });
        if (r.ok) return 'st';
    } catch (e) { /* 忽略 */ }
    return 'none';
}

// ── 出图占位符：触发即显示“加载中”，图完成替换成图片 ──
let taSpinInjected = false;
function injectTaSpinKeyframes() {
    if (taSpinInjected) return;
    taSpinInjected = true;
    $('head').append('<style>@keyframes taSpin{to{transform:rotate(360deg)}}.ta-img-ph{display:flex;align-items:center;gap:12px;width:fit-content;min-width:260px;max-width:480px;margin:6px 0 10px;padding:12px 16px;border-radius:12px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.3);color:#aeb4c6;font-size:15px}.ta-img-spin{width:20px;height:20px;border:3px solid rgba(255,255,255,.18);border-top-color:#818cf8;border-radius:50%;animation:taSpin 1s linear infinite;flex-shrink:0}.ta-img-done{margin:6px 0 10px;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.12);display:inline-block;max-width:480px;background:rgba(255,255,255,.03)}.ta-img-done img{display:block;max-width:480px;width:100%;height:auto;border-radius:12px;}</style>');
}
function addImgPlaceholder(msgId) {
    let $el = msgId ? $('.mes[mesid="' + msgId + '"]') : $();
    if (!$el.length) $el = $('.mes').last();          // 消息无 id/未渲染：兜底挂最后一条消息下
    if (!$el.length) return;                          // 聊天区无消息：跳过（不阻断出图）
    if ($el.find('.ta-img-ph').length) return;        // 已有占位不重复
    injectTaSpinKeyframes();
    const $txt = $el.find('.mes_text').last();
    const first = !$el.find('.ta-img-ph, .ta-img-done').length;   // 第一条图 → 文本上方；第二条 → 文本下方
    const html = '<div class="ta-img-ph"><span class="ta-img-spin"></span><span>自动文生图：正在生成图…（完成后自动显示）</span></div>';
    if ($txt.length && first) {
        $txt.before(html);
    } else if ($txt.length) {
        $txt.after(html);
    } else {
        $el.append(html);
    }
}
function replaceImgPlaceholder(url) {
    const $p = $('.ta-img-ph').first();
    if (!$p.length) return false;
    injectTaSpinKeyframes();
    $p.replaceWith('<div class="ta-img-done"><img src="' + url + '" alt="生成图" onerror="this.parentElement.remove();"></div>');
    return true;
}
function removeImgPlaceholder() {
    $('.ta-img-ph').remove();
}

// 已显示过的图片 url（防重复投递/重复连接导致重复消息）
const shownImages = new Set();

function showImage(data) {
    try {
        const url = data.url || data.image;
        console.log('[ta-img][st] ⑨ showImage 进入, url=', url);
        if (!url) return;
        // 三重防重：同 url 已显示 → 跳过（不管谁重复投递）
        if (shownImages.has(url)) return;
        shownImages.add(url);
        // 有占位符 → 先即时替换成图（视觉；数据层下面继续挂）
        const replaced = replaceImgPlaceholder(url);
        // 兜底：chat 里已存在同 url 消息 → 跳过
        const ctx = getCtx();
        if (ctx && ctx.chat && ctx.chat.some(m => m.extra && m.extra.media && m.extra.media.some(x => x.url === url))) { if (replaced) toastr.success('✨ 已生成图片', '自动文生图'); return; }
        // ── 附加到目标角色消息（不新增消息）────────────────────
        // 目标 = 本次触发者 pendingImgTarget（仍在 chat 中）；否则取最近一条
        // 非用户、非系统、且名称不含「生图/文生图」的消息
        let target = null;
        if (ctx && ctx.chat) {
            if (pendingImgTarget && ctx.chat.some(m => m && m.id === pendingImgTarget.id)) target = pendingImgTarget;
            if (!target) {
                for (let i = ctx.chat.length - 1; i >= 0; i--) {
                    const m = ctx.chat[i];
                    if (!m) continue;
                    const nm = String(m.name || '').toLowerCase();
                    if (!m.is_user && !m.is_system && !nm.includes('生图') && !nm.includes('文生图')) { target = m; break; }
                }
            }
        }
        if (target) {
            target.extra = target.extra || {};
            target.extra.media = target.extra.media || [];
            if (!target.extra.media.some(x => x.url === url)) {
                target.extra.media.push({ url: url, type: 'image', title: data.model || '' });
                let $el = $('.mes[mesid="' + target.id + '"]');
                if (!$el.length) $el = $('.mes').last();   // 无 id/未渲染：挂最后一条回复下
                if ($el.length && !replaced) {
                    try { appendMediaToMessage(target, $el, 'keep'); } catch (e2) { console.warn('[tavern-auto-img] 追加媒体渲染失败:', e2); }
                } else if ($el.length && replaced) {
                    // 已用 DOM 大图替换占位：数据保留（刷新/滚动后仍显示），不重复渲染列表
                } else {
                    // 虚拟滚动：目标消息不在渲染池 → 滚到底触发渲染后重试一次
                    console.info('[tavern-auto-img] 目标消息未渲染，滚动重试…', target.id);
                    const $chat = $('#chat');
                    if ($chat.length) {
                        $chat.scrollTop($chat[0].scrollHeight);
                        setTimeout(() => {
                            const $el2 = $('.mes[mesid="' + target.id + '"]');
                            if ($el2.length) { try { appendMediaToMessage(target, $el2, 'keep'); } catch (e3) { /* 忽略 */ } }
                        }, 600);
                    }
                }
            }
            saveChatDebounced();
            toastr.success('✨ 已生成图片（已附加到角色回复下方）', '自动文生图');
            return;
        }
        // ── 兜底：找不到目标消息 → 原有推送新消息逻辑 ──
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
        toastr.success('✨ 已生成图片', '自动文生图');
    } catch (err) {
        console.error('[tavern-auto-img] 显示失败:', err);
    }
}

// 失败才需要框框：红色消息 + 提示
function showError(data) {
    const msg = (data && (data.message || data.error)) || '出图失败，请查看桥日志';
    try {
        removeImgPlaceholder();   // 失败时清掉占位符
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
    const $head = $('<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,.06);background:linear-gradient(90deg,rgba(129,140,248,.10),rgba(56,189,248,.06));flex-wrap:wrap;gap:8px;"></div>')
        .append($('<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;"></div>')
            .append('<div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#4158d0,#6a5af9);display:flex;align-items:center;justify-content:center;font-size:23px;box-shadow:0 6px 18px rgba(80,90,220,.45);flex-shrink:0;">⚡</div>')
            .append('<div style="flex-shrink:0;"><div style="font-size:19px;font-weight:700;letter-spacing:.5px;background:linear-gradient(90deg,#818cf8,#38bdf8);-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap;">自动文生图控制台</div><div style="font-size:12px;color:rgba(230,230,242,.55);margin-top:2px;white-space:nowrap;">角色回复 → 提示词 → ComfyUI 出图</div></div>')
            .append('<span id="ta-img-bind" style="display:inline-flex;align-items:center;gap:6px;background:rgba(251,191,36,.10);border:1px solid rgba(251,191,36,.4);color:#fbbf24;font-size:13px;padding:4px 10px;border-radius:999px;white-space:nowrap;flex-shrink:0;">⌛ 联动检测中…</span>'));
    $head.append('<span id="ta-img-close" style="cursor:pointer;font-size:20px;color:#9aa;padding:4px 8px;border-radius:8px;white-space:nowrap;flex-shrink:0;">✕</span>');
    $card.append($head);
    $card.find('#ta-img-close').on('click', closePanel);
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
        // 无桥模式：直接中断前端请求（socket 断开 → ST 代理会给 ComfyUI 发 /interrupt）
        if (stAbort && !stAbort.signal.aborted) {
            try { stAbort.abort(); toastr.success('已发送急停（无桥模式）', '自动文生图'); }
            catch (e) { toastr.error('急停失败', '自动文生图'); }
            return;
        }
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
    const $rowAuto = mkRow('fa-magic', '模型选择（自动发现）：');
    const $autoSel = $('<select id="tavern-img-automodel" style="max-width:260px;font-size:16px;"><option value="">未选择</option></select>');
    const $autoHint = $('<span class="muted" style="margin-left:6px;font-size:16px;"></span>');
    $rowAuto.append($autoSel, $autoHint);
    $rowAuto.hide();
    $panel.append($rowAuto);

    // ② LoRA 勾选（下拉弹窗多选；可从桥动态拉取，按当前模型家族适配；不兼容红色标注）
    const $rowLora = mkRow('fa-layer-group', 'LoRA 选择（不勾也行，非必须项）：');
    const $btnLoraRefresh = $('<button id="tavern-img-loras-refresh" class="menu_button" style="min-width:70px;white-space:nowrap;">🔄 刷新 LoRA</button>');
    const $loraToggle = $('<button id="tavern-img-loras-open" class="menu_button" style="min-width:170px;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">LoRA：已选 0</button>');
    const $loraPop = $('<div id="tavern-img-loras-pop" style="display:none;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2200;background:#171927;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px 10px;max-height:72vh;overflow-y:auto;width:min(620px,92vw);box-shadow:0 24px 70px rgba(0,0,0,.75);"></div>');
    const $loraBox = $('<div id="tavern-img-loras" style="display:flex;flex-direction:column;gap:2px;"></div>');
    $loraPop.append($loraBox);
    const $loraChips = $('<div id="tavern-img-lora-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;width:100%;"></div>');
    $rowLora.append($loraToggle, $btnLoraRefresh, $loraPop, $loraChips);
    // 无桥模式 LoRA 手动输入（ST 代理没有枚举端点；装桥后自动枚举勾选）
    const $stLoraWrap = $('<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:100%;margin-top:4px;"></div>');
    const $stLoraIn = $('<input id="tavern-img-loras-manual" class="text_pole" style="flex:2;min-width:220px;font-size:15px;" placeholder="逗号分隔 LoRA 文件名，如 femboysXL.safetensors, japanese_girl_v1.1.safetensors">');
    const $stLoraBtn = $('<button id="tavern-img-loras-manual-save" class="menu_button" style="min-width:70px;font-size:15px;white-space:nowrap;">💾 保存</button>');
    const $loraManualHint = $('<span class="muted" style="font-size:14px;width:100%;margin-top:2px;">（无桥模式：LoRA 需手动输入，文件放在 ComfyUI 的 models/loras 目录；装桥后可自动枚举）</span>');
    $stLoraWrap.append($stLoraIn, $stLoraBtn, $loraManualHint);
    $rowLora.append($stLoraWrap);
    $stLoraWrap.hide();
    function updateManualLoraChips() {
        const arr = taGetLocalCfg().loras || [];
        $loraChips.empty();
        arr.forEach(f => {
            const short = String(f).replace(/\.safetensors$/i, '').slice(0, 22);
            $loraChips.append(`<span style="background:#232543;border:1px solid rgba(129,140,248,.45);color:#a5b4fc;border-radius:8px;padding:3px 10px;font-size:13px;">${short}</span>`);
        });
        if (arr.length) $loraChips.prepend(`<span style="font-size:13px;color:rgba(230,230,242,.6);align-self:center;">已选（手动）：</span>`);
        $loraToggle.text(arr.length ? `LoRA：手动 ${arr.length}` : 'LoRA：手动 0');
    }
    $stLoraBtn.on('click', function () {
        const arr = ($stLoraIn.val() || '').split(/[,，]+/).map(s => s.trim()).filter(Boolean);
        taSetLocalCfg({ loras: arr });
        updateManualLoraChips();
        toastr.success(arr.length ? `已保存 ${arr.length} 个 LoRA（无桥·本地）` : '已清空 LoRA（无桥·本地）', '自动文生图');
    });
    (function initManualLora() {
        try {
            const arr = taGetLocalCfg().loras || [];
            if (Array.isArray(arr) && arr.length) $stLoraIn.val(arr.join(', '));
            updateManualLoraChips();
        } catch (e) { /* 忽略 */ }
    })();
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
    const $rowSpeed = mkRow('fa-bolt', '速度档位：');
    const $sizeSel = $('<select id="tavern-img-sizemult" style="margin-right:10px;font-size:16px;"></select>');
    const $stepsSel = $('<select id="tavern-img-stepsmult" style="font-size:16px;"></select>');
    const $sizeLab = $('<span class="muted" style="margin-right:6px;">步子×</span>');
    const $stepsLab = $('<span class="muted" style="margin-right:6px;">尺寸×</span>');
    // 顺序：先标尺寸
    $rowSpeed.append($sizeLab, $sizeSel, $stepsLab, $stepsSel);
    $panel.append($rowSpeed);

    // ④ 模型目录自选（extra_model_paths 管理）
    const $rowPaths = mkRow('fa-folder-open', '模型 / LoRA 目录（保存后重启 ComfyUI 生效）：');
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
    const $rowCfg = mkRow('fa-server', 'ComfyUI 地址：');
    const $inComfy = $('<input id="tavern-img-comfy" class="text_pole" style="flex:1;min-width:140px;font-size:16px;" placeholder="ComfyUI 地址，如 http://127.0.0.1:8188">');
    const $btnComfy = $('<button id="tavern-img-comfy-save" class="menu_button" style="min-width:70px;white-space:nowrap;">保存地址</button>');
    const $comfyOk = $('<span class="muted" style="margin-left:8px;font-size:15px;"></span>');
    const $comfyHint = $('<span class="muted" style="font-size:14px;width:100%;margin-top:2px;">（就是你能打开 ComfyUI 的那个网址，浏览器里能打开它就能连）</span>');
    $rowCfg.append($inComfy, $btnComfy, $comfyOk, $comfyHint);
    $panel.append($rowCfg);

    // ⑤b 提示词引擎 API：行1 模式选择+状态；行2 Endpoint；行3 Key+模型；行4 三个操作按钮一排
    const $rowLLM = mkRow('fa-key', '提示词引擎 API：');
    const $llmMode = $('<select id="tavern-img-llm-mode" style="min-width:150px;font-size:16px;margin-right:8px;">'
        + '<option value="tavern">用酒馆主 API</option>'
        + '<option value="custom">自定义 API</option>'
        + '</select>');
    const $btnTest = $('<button id="tavern-img-llm-test" class="menu_button" style="min-width:96px;white-space:nowrap;font-size:15px;padding:7px 14px;">🔌 测试连接</button>');
    const $btnLlmModels = $('<button id="tavern-img-llm-models-btn" class="menu_button" title="从该 API 获取模型列表" style="min-width:110px;font-size:15px;white-space:nowrap;padding:7px 14px;">📋 获取模型</button>');
    const $llmHint = $('<span class="muted" style="margin-right:8px;font-size:15px;"></span>');
    $rowLLM.append($llmMode, $llmHint);

    // ⑤c 自定义 API：三行式（① Endpoint 整行 ② Key + 模型 ③ 保存按钮）——不挤占、占位符完整
    const $rowCustom = $('<div style="margin:6px 0 0 28px;display:flex;flex-direction:column;gap:6px;"></div>');
    const $inLlmEndpoint = $('<input id="tavern-img-llm-endpoint" class="text_pole" style="flex:1 1 100%;min-width:0;font-size:16px;" placeholder="Endpoint，如 https://api.deepseek.com 或 http://127.0.0.1:18789/v1">');
    const $inLlmKey = $('<input id="tavern-img-llm-key" class="text_pole" type="password" style="flex:1 1 240px;min-width:150px;font-size:16px;" placeholder="API Key（选填）">');
    const $inLlmModel = $('<input id="tavern-img-llm-model" class="text_pole" list="ta-img-llm-models" style="flex:1 1 200px;min-width:120px;font-size:16px;" placeholder="模型名，如 deepseek-v4-flash">');
    const $btnLlmSave = $('<button id="tavern-img-llm-save" class="menu_button" style="min-width:88px;white-space:nowrap;font-size:15px;padding:7px 14px;">💾 保存 API</button>');
    const $rowLlmEp = $('<div style="display:flex;align-items:center;gap:8px;"></div>').append($inLlmEndpoint);
    const $rowLlmKm = $('<div style="display:flex;align-items:center;gap:8px;"></div>').append($inLlmKey, $inLlmModel);
    const $rowLlmButtons = $('<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"></div>').append($btnTest, $btnLlmModels, $btnLlmSave);
    $rowCustom.append($rowLlmEp, $rowLlmKm, $rowLlmButtons);
    $rowLLM.append($rowCustom);
    // 模型列表 datalist（原生下拉建议）
    const $dlModels = $('<datalist id="ta-img-llm-models"></datalist>');
    $rowLLM.append($dlModels);
    $btnLlmModels.on('click', async function () {
        if ($btnLlmModels.prop('disabled')) return;   // 防抖：请求中不再触发
        const endpoint = ($inLlmEndpoint.val() || '').trim();
        const key = ($inLlmKey.val() || '').trim();
        if (!endpoint) { toastr.error('请先填写 Endpoint', '自动文生图'); return; }
        try {
            $btnLlmModels.prop('disabled', true).text('⏳ 获取中…');
            if (!connected) {
                // 无桥模式：走酒馆服务端代理拉模型列表
                // key 框有值 → 先写入酒馆密钥库（正确槽 api_key_custom，拿独立 id）再拉；空且无 id → 提示
                const sid0 = ((taGetLocalCfg().llm || {}).secretId || '').trim();
                let sid = sid0;
                if (!key && !sid) {
                    toastr.error('获取模型前请先填 API Key（填入后点保存/或点获取自动存入密钥库）', '自动文生图');
                    $btnLlmModels.prop('disabled', false).text('📋 获取模型');
                    return;
                }
                if (key) {
                    try {
                        // 旧 id 若存在先删（同槽，避免堆积）
                        if (sid) {
                            try { await fetch('/api/secrets/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ key: 'api_key_custom', id: sid }) }); } catch (e3) { /* 忽略 */ }
                        }
                        const newId = await writeTaImgSecret(key);
                        if (newId) {
                            sid = newId;
                            taSetLocalCfg({ llm: { secretId: sid } });
                        }
                        if (sid0 !== sid) $inLlmKey.val('');   // 已换新：隐藏刚刚输入的 key
                    } catch (e2) { console.warn('[ta-img] 预存 key 失败:', e2); }
                }
                // 拉模型列表：先按原样（{url}/models），失败再补 /v1（DeepSeek/OpenAI 兼容常用 /v1/models）
                const base = endpoint.replace(/\/+$/, '');
                const urls = [base];
                if (!/\/v1$/i.test(base)) urls.push(base + '/v1');
                let models = [];
                let lastErr = '';
                for (const u of urls) {
                    try {
                        const body = { chat_completion_source: 'custom', custom_url: u };
                        if (sid) body.secret_id = sid;
                        const resp = await fetch('/api/backends/chat-completions/status', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify(body),
                        });
                        const d = await resp.json();
                        const got = (Array.isArray(d?.data) ? d.data : []).map(m => m.id || m.name).filter(Boolean);
                        if (got.length) { models = got; break; }
                        lastErr = String(d?.error || d?.message || ('HTTP ' + resp.status));
                    } catch (e) { lastErr = (e?.message || String(e)); }
                }
                if (models.length) {
                    $dlModels.empty().append(models.map(m => `<option value="${String(m).replace(/"/g, '')}">`).join(''));
                    toastr.success(`已获取 ${models.length} 个模型（点模型框选列表）`, '自动文生图');
                } else {
                    toastr.error('该 API 未返回模型列表（已自动试 /v1 补齐；仍失败请核对 endpoint/key）:' + lastErr.slice(0, 80), '自动文生图', { newestOnTop: true });
                }
            } else {
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
    const $rowPrompt = mkRow('fa-pen-to-square', '提示词规则（编辑后保存，下次出图生效，不用改代码）：');
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
        if (!connected) {
            // 无桥模式：本地 prompt_edit
            const pe = (taGetLocalCfg().prompt_edit || '');
            if (pe) $taPrompt.val(pe);
            const act = !!pe.trim();
            $promptStatus.text(act ? '（自定义已生效）' : '（默认模板）').css('color', act ? '#8bc34a' : '');
            $pmStatus.text(act ? '（自定义已生效）' : '（默认模板）').css('color', act ? '#8bc34a' : '');
            return;
        }
        fetch(BRIDGE + '/prompt').then(r => r.json()).then(d => {
            if (!d) return;
            $taPrompt.val(d.override || d.system || '');
            $promptStatus.text(d.active ? '（自定义已生效）' : '（默认模板）').css('color', d.active ? '#8bc34a' : '');
            $pmStatus.text(d.active ? '（自定义已生效）' : '（默认模板）').css('color', d.active ? '#8bc34a' : '');
        }).catch(() => {});
    }
    $btnPromptToggle.on('click', openPromptModal);
    $btnPromptSave.on('click', async function () {
        if (!connected) {
            // 无桥模式：规则文本存本地，stEngineer 出图时覆盖默认模板
            taSetLocalCfg({ prompt_edit: $taPrompt.val() });
            const act = !!($taPrompt.val() || '').trim();
            $promptStatus.text(act ? '（自定义已生效）' : '（默认模板）').css('color', act ? '#8bc34a' : '');
            $pmStatus.text(act ? '（自定义已生效）' : '（默认模板）').css('color', act ? '#8bc34a' : '');
            toastr.success(act ? '提示词规则已保存并生效（无桥·本地）' : '已恢复默认模板（无桥·本地）', '自动文生图');
            return;
        }
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
        if (!connected) {
            // 无桥模式：清空本地规则文本
            taSetLocalCfg({ prompt_edit: '' });
            $taPrompt.val('');
            $promptStatus.text('（默认模板）').css('color', '');
            $pmStatus.text('（默认模板）').css('color', '');
            toastr.success('已恢复默认模板（无桥·本地）', '自动文生图');
            return;
        }
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

    // ⑧ 工作流模式：🤖 自适应（傻瓜式·推荐） / 🧩 自定义工作流（粘贴JSON，高级）
    const $rowWf = mkRow('fa-diagram-project', '工作流模式：');
    const $btnWfAuto = $('<button id="tavern-img-wf-auto" class="menu_button" style="min-width:118px;font-size:15px;white-space:nowrap;padding:6px 10px;">🤖 自适应（推荐）</button>');
    const $btnWfToggle = $('<button id="tavern-img-wf-toggle" class="menu_button" title="粘贴你自己的 API 格式工作流 JSON，启用后自动构建让位" style="min-width:132px;font-size:15px;white-space:nowrap;padding:6px 10px;">🧩 自定义工作流</button>');
    const $wfStatus = $('<span class="muted" style="margin-left:8px;font-size:15px;"></span>');
    $rowWf.append($btnWfAuto, $btnWfToggle, $wfStatus);
    $panel.append($rowWf);
    function setWfMode(mode) {
        const on = 'border:2px solid rgba(139,195,74,.65)!important;color:#c6e8c6!important;background:rgba(139,195,74,.10)!important;';
        const off = 'border:1px solid rgba(255,255,255,.12);color:#e8e8f2;';
        $btnWfAuto.attr('style', $btnWfAuto.attr('style').replace(/border[^;]*;/g, '').replace(/color:[^;]*;/g, '').replace(/background:[^;]*;/g, '') + ';' + (mode === 'auto' ? on : off));
        $btnWfToggle.attr('style', $btnWfToggle.attr('style').replace(/border[^;]*;/g, '').replace(/color:[^;]*;/g, '').replace(/background:[^;]*;/g, '') + ';' + (mode === 'custom' ? on : off));
    }
    function wfHasContent(w) { return !!(w && typeof w === 'object' && !Array.isArray(w) && Object.keys(w).length); }
    $btnWfAuto.on('click', async function () {
        // 切回自适应模式（自动构建）：置 enabled=false
        if (!connected) { taSetLocalCfg({ wf: { enabled: false, wf: (taGetLocalCfg().wf || {}).wf || {} } }); }
        else { try { await fetch(BRIDGE + '/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false, wf: {} }) }); } catch (e) { /* 忽略 */ } }
        setWfMode('auto');
        $wfStatus.text('（自适应·自动构建）').css('color', '');
        toastr.info('已切换到自适应模式：自动选择模型/LoRA 构建工作流', '自动文生图');
    });
    $btnWfToggle.on('click', async function () {
        openWfModal();
        // 若已有自定义 JSON → 直接进出自定义模式；没有 → 打开弹窗让用户粘贴
        const cur = !connected ? (taGetLocalCfg().wf || {}) : null;
        const hasWf = !connected ? wfHasContent(cur.wf) : null;
        if (!connected && hasWf) {
            taSetLocalCfg({ wf: { enabled: true, wf: cur.wf } });
            setWfMode('custom');
            $wfStatus.text('（自定义已启用）').css('color', '#8bc34a');
        }
    });
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
        if (!connected) {
            // 无桥模式：本地 wf={enabled,wf}
            const lw = taGetLocalCfg().wf || {};
            const hasWf = !!(lw.wf && typeof lw.wf === 'object' && !Array.isArray(lw.wf) && Object.keys(lw.wf).length);
            $taWf.val(lw.wf ? JSON.stringify(lw.wf, null, 2) : '');
            $wfEn.prop('checked', !!lw.enabled);
            $wfStatus.text(lw.enabled && hasWf ? '（自定义已启用）' : '（自适应·自动构建）').css('color', lw.enabled && hasWf ? '#8bc34a' : '');
            setWfMode(lw.enabled && hasWf ? 'custom' : 'auto');
            return;
        }
        fetch(BRIDGE + '/workflow').then(r => r.json()).then(d => {
            if (!d) return;
            $taWf.val(d.wf ? JSON.stringify(d.wf, null, 2) : '');
            $wfEn.prop('checked', !!d.enabled);
            $wfStatus.text(d.enabled && d.wf ? '（自定义已启用）' : '（自适应·自动构建）').css('color', d.enabled && d.wf ? '#8bc34a' : '');
            setWfMode(d.enabled && d.wf ? 'custom' : 'auto');
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
        if (!connected) {
            // 无桥模式：工作流存本地，generateViaST 出图前优先使用
            taSetLocalCfg({ wf: { enabled: $wfEn.prop('checked'), wf: wf } });
            const hasWf = !!(wf && typeof wf === 'object' && !Array.isArray(wf) && Object.keys(wf).length);
            $wfStatus.text($wfEn.prop('checked') && hasWf ? '（自定义已启用）' : '（自动构建）').css('color', $wfEn.prop('checked') && hasWf ? '#8bc34a' : '');
            toastr.success($wfEn.prop('checked') && hasWf ? `自定义工作流已启用（${Object.keys(wf).length} 节点·无桥本地）` : '已切换为自动构建（无桥本地）', '自动文生图');
            return;
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
        if (!connected) {
            taSetLocalCfg({ wf: { enabled: false, wf: {} } });
            $wfStatus.text('（自动构建）').css('color', '');
            toastr.success('已清空自定义工作流（自动构建）', '自动文生图');
            return;
        }
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
        // ── 无桥模式：浏览器直连 ComfyUI 枚举 LoRA（ComfyUI 已开 --enable-cors-header）──
        return fetchLorasViaComfy();
    }

    /** 无桥 LoRA 自动枚举：直连 {comfyUrl}/object_info/LoraLoader（失败回退 false） */
    async function fetchLorasViaComfy() {
        try {
            let comfyUrl = (document.getElementById('tavern-img-comfy')?.value || '').trim() || 'http://127.0.0.1:8188';
            try { comfyUrl = comfyUrl || (JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}').comfy_url || '').trim() || 'http://127.0.0.1:8188'; } catch (e) { /* 忽略 */ }
            comfyUrl = comfyUrl.replace(/\/+$/, '');
            const r = await fetch(`${comfyUrl}/object_info/LoraLoader`);
            if (!r.ok) return false;
            const oi = await r.json();
            const req = oi?.LoraLoader?.input?.required?.lora_name;
            let list = [];
            if (Array.isArray(req?.[0])) list = req[0];
            else if (Array.isArray(req?.[1]?.options)) list = req[1].options;
            if (!list.length) return false;
            currentLoras = list.filter(x => typeof x === 'string').map(f => ({ file: f, family: stDetectFamily(f), label: f, meta_err: '' }));
            return true;
        } catch (e) { return false; }
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
        const sizeMultV = parseFloat($sizeSel.val());
        const stepsMultV = parseFloat($stepsSel.val());
        const body = {
            key: $select.val(),
            loras: loras,
            size_mult: sizeMultV,
            steps_mult: stepsMultV,
        };
        if (!connected) {
            // 无桥模式：速度档位存本地（模型/LoRA 由各自面板项保存）
            taSetLocalCfg({ size_mult: Number.isFinite(sizeMultV) ? sizeMultV : 1, steps_mult: Number.isFinite(stepsMultV) ? stepsMultV : 1 });
            toastr.success('速度档位已保存（无桥模式·本地）', '自动文生图');
            return;
        }
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
            if (!resp.ok) throw new Error('桥不可用');
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
            // ── 桥不可用 → 无桥模式：用 ST 代理拉模型清单（零桥也能选模型）──
            try {
                const comfyUrl = (document.getElementById('tavern-img-comfy')?.value || '').trim() || 'http://127.0.0.1:8188';
                const mr = await fetch('/api/sd/comfy/models', {
                    method: 'POST', headers: getRequestHeaders(),
                    body: JSON.stringify({ url: comfyUrl.replace(/\/+$/, '') }),
                });
                if (mr.ok) {
                    const arr = await mr.json();
                    const recs = (Array.isArray(arr) ? arr : []).map(m => ({ file: m.value, family: stDetectFamily(m.value), label: m.text || m.value }));
                    currentAutoModels = recs;
                    $rowAuto.show();
                    $autoSel.empty().append('<option value="">未选择</option>');
                    recs.forEach(m => { $autoSel.append(`<option value="${m.file}">${m.label || m.file}</option>`); });
                    // 没选过 → 默认选第一个（优先轻量 SDXL，出图快）；再挑第一个
                    const saved = JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}').auto_model || '';
                    if (saved && recs.some(m => m.file === saved)) $autoSel.val(saved);
                    else {
                        const fast = recs.find(m => m.family === 'sdxl') || recs[0];
                        if (fast) $autoSel.val(fast.file);
                    }
                    const cur = $autoSel.val();
                    if (cur) {
                        const rec = recs.find(m => m.file === cur);
                        $autoHint.text(rec ? `家族：${rec.family || '-'}` : '');
                        localStorage.setItem('taImgLocalCfg', JSON.stringify({ ...(JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}')), auto_model: cur }));
                    }
                    // 回填速度档位（无桥·本地保存值，免得每次刷新重选）
                    try {
                        const lc = JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}');
                        if (lc.size_mult != null) $sizeSel.val(String(lc.size_mult));
                        if (lc.steps_mult != null) $stepsSel.val(String(lc.steps_mult));
                    } catch (e) { /* 忽略 */ }
                    $select.empty().append('<option value="">无桥模式（模型在右侧动态列表）</option>');
                } else {
                    $select.empty().append('<option value="">桥接服务未连接</option>');
                }
            } catch (e2) {
                $select.empty().append('<option value="">桥接服务未连接</option>');
            }
            // 无桥模式：总开关状态读本地；面板按无桥能力灰化
            const en = (taGetLocalCfg().enabled !== false);
            $btn.toggleClass('on', en);
            $swState.text(en ? '开启' : '关闭').css('color', en ? '#8bc34a' : '#8a8f9e');
            try { applyChannelUI('st'); panelRefreshStatus(); } catch (e) { /* 忽略 */ }
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
        try { refreshModeStats(); } catch (e2) { /* 忽略 */ }
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
        if (!connected) {
            // 无桥模式：直接探测 ComfyUI（ST 代理 ping 端点，带同级请求头）
            try {
                const comfyUrl = ($inComfy.val() || '').trim() || (taGetLocalCfg().comfy_url || '').trim() || 'http://127.0.0.1:8188';
                const ctl = new AbortController();
                setTimeout(() => ctl.abort(), 3000);
                const r = await fetch('/api/sd/comfy/ping', {
                    method: 'POST', headers: getRequestHeaders(),
                    body: JSON.stringify({ url: comfyUrl.replace(/\/+$/, '') }),
                    signal: ctl.signal,
                });
                $comfyOk.html(r.ok ? '<span style="color:#8bc34a;">✅ 已连接（无桥·ST 代理探测）</span>' : '<span style="color:#e74c3c;">❌ 未连接</span>');
            } catch (e) {
                $comfyOk.html('<span style="color:#e74c3c;">❌ 未连接</span>');
            }
            return;
        }
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
        } catch (e) {
            // 桥不可用 → 无桥模式：从本地恢复 LLM 配置与 ComfyUI 地址
            try {
                const lc = taGetLocalCfg();
                const llm = lc.llm || {};
                const mode = llm.mode === 'tavern' ? 'tavern' : 'custom';
                setLlmUI(mode);
                if (mode === 'tavern') {
                    $tavernInfo.html(`Endpoint：${llm.endpoint || '-'} · 模型：${llm.model || '-'} · Key：<span style="color:#8bc34a;">✓ 用酒馆 secrets</span>`);
                } else {
                    $inLlmEndpoint.val(llm.endpoint || '');
                    $inLlmModel.val(llm.model || '');
                }
                currentLlm = { mode: mode, endpoint: llm.endpoint || '', model: llm.model || '', key_configured: !!llm.key_configured };
                if (llm.endpoint || llm.model) $llmHint.text('🔑 已就绪（无桥·本地）').css('color', '#8bc34a');
                if (lc.comfy_url) $inComfy.val(lc.comfy_url);
            } catch (e2) { /* 忽略 */ }
        }
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
        if (!connected) {
            // 无桥模式：地址存本地（无需桥）
            try { localStorage.setItem('taImgLocalCfg', JSON.stringify({ ...(JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}')), comfy_url })); } catch (e) { /* 忽略 */ }
            toastr.success('ComfyUI 地址已保存（无桥模式·本地）', '自动文生图');
            checkComfyStatus();
            return;
        }
        try {
            const resp = await fetch(BRIDGE + '/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comfy_url }),
            });
            const data = await resp.json();
            if (data.ok) {
                toastr.success('ComfyUI 地址已保存', '自动文生图');
                checkComfyStatus();
            } else {
                toastr.error(data.error || '保存失败', '自动文生图');
            }
        } catch (e) {
            toastr.error('无法保存 ComfyUI 地址：' + (e?.message || e), '自动文生图');
        }
    });

    // 父选项切换：用酒馆主 API（读取+保存）/ 自定义 API（展开三栏）
    $llmMode.on('change', async function () {
        if ($(this).val() === 'tavern') {
            if (!connected) {
                // 无桥模式：主 API 即 custom 源（key 用酒馆 secrets）→ 读酒馆配置存本地
                const t = await readTavernApiSettings().catch(() => null);
                if (t && t.endpoint) {
                    $inLlmEndpoint.val(t.endpoint);
                    $inLlmModel.val(t.model || '');
                    taSetLocalCfg({ llm: { mode: 'tavern', endpoint: t.endpoint, model: t.model || '', key_configured: !!t.key } });
                    setLlmUI('tavern');
                    $tavernInfo.html(`Endpoint：${t.endpoint} · 模型：${t.model || '-'} · Key：<span style="color:#8bc34a;">✓ 用酒馆 secrets</span>`);
                    currentLlm = { mode: 'tavern', endpoint: t.endpoint, model: t.model || '', key_configured: true };
                    $llmHint.text('🔑 主 API 就绪').css('color', '#8bc34a');
                    toastr.success('已配置为酒馆主 API（无桥模式·出图时走酒馆代理）', '自动文生图');
                } else {
                    toastr.error('无法读取酒馆主 API 配置，请改为自定义 API 并手动填写', '自动文生图');
                    setLlmUI('custom');
                }
                return;
            }
            useTavernApi();
        }
        else { setLlmUI('custom'); }
    });

    // 保存自定义 LLM（POST /config {llm:{mode:'custom',endpoint,key,model}}；成功清空 key 输入框）
    $btnLlmSave.on('click', async function () {
        const endpoint = $inLlmEndpoint.val().trim();
        const key = $inLlmKey.val().trim();
        const model = $inLlmModel.val().trim();
        if (!endpoint) {
            toastr.error('Endpoint 不能为空', '自动文生图');
            return;
        }
        if (!model) {
            toastr.info('模型名先留空也行（保存后点「获取模型」或稍后补填）', '自动文生图');
        }
        if (!connected) {
            // 无桥模式：endpoint/model 存本地；key 若填写 → 存入酒馆密钥库（独立槽，不影响酒馆自身 API）→ 输入框清空隐藏
            if (key) {
                try {
                    const sidOld = ((taGetLocalCfg().llm || {}).secretId || '').trim();
                    if (sidOld) {
                        try { await fetch('/api/secrets/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ key: 'api_key_custom', id: sidOld }) }); } catch (e3) { /* 忽略 */ }
                    }
                    const newId = await writeTaImgSecret(key);
                    taSetLocalCfg({ llm: { mode: 'custom', endpoint: endpoint, model: model, secretId: newId || '' } });
                    $inLlmKey.val('');
                    $llmHint.text('🔑 已就绪（key 已存密钥库）').css('color', '#8bc34a');
                    toastr.success('✓ key 已存入酒馆密钥库（输入框已隐藏；要换 key 重新填写即可）', '自动文生图');
                } catch (e) {
                    toastr.error('key 保存失败：' + (e?.message || e), '自动文生图');
                }
            } else {
                taSetLocalCfg({ llm: { mode: 'custom', endpoint: endpoint, model: model } });
                $inLlmKey.val('');
                $llmHint.text('🔑 已就绪（无桥·本地）').css('color', '#8bc34a');
                toastr.success('✓ 已保存（endpoint/模型；key 未填）', '自动文生图');
            }
            currentLlm = { mode: 'custom', endpoint: endpoint, model: model, key_configured: !!key };
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

    // 🔌 测试连接（桥模式：GET /config/test；无桥模式：直测酒馆主 API 代理）
    $btnTest.on('click', async function () {
        $btnTest.prop('disabled', true).text('测试中…');
        try {
            if (!connected) {
                const t0 = performance.now();
                let endpoint = $inLlmEndpoint.val().trim() || 'http://127.0.0.1:18789/v1';
                let model = $inLlmModel.val().trim() || 'openclaw/tavern';
                if ($llmMode.val() === 'tavern') {
                    // 无桥·主 API 模式：以酒馆当前主 API 配置为准
                    const t = await readTavernApiSettings().catch(() => null);
                    if (t && t.endpoint) { endpoint = t.endpoint; if (t.model) model = t.model; }
                }
                const resp = await fetch('/api/backends/chat-completions/generate', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: 'ping' }],
                        chat_completion_source: 'custom',
                        custom_url: endpoint,
                        model: model,
                        max_tokens: 1,
                        temperature: 0,
                        stream: false,
                    }),
                });
                const data = await resp.json().catch(() => null);
                if (resp.ok && data && !data.error) {
                    const txt = `✓ 主 API 连通 ${Math.round(performance.now() - t0)} ms`;
                    $llmHint.text(txt).css('color', '#8bc34a');
                    toastr.success(txt, '自动文生图');
                } else {
                    toastr.error(String(data?.error?.message || '连接失败 ' + resp.status), '自动文生图');
                }
                return;
            }
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
        // 手动选择也记本地（无桥 generateViaST 兜底；桥模式同存无副作用）
        taSetLocalCfg({ auto_model: file });
        if (!connected) {
            toastr.success(file ? `模型已设为 ${rec?.label || file}（无桥·本地）` : '已清除模型（无桥·本地）', '自动文生图');
            return;
        }
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

    // ── 通道状态切换（无桥模式灰化依赖桥的能力 + 中文说明；桥模式恢复原样）──
    applyChannelUI = function (ch) {
        const noBridge = (ch === 'st' || ch === 'none');
        // ① 模型/LoRA 目录：需要桥写 extra_model_paths；无桥 → 灰化 + 说明
        $rowPaths.css('opacity', noBridge ? '0.5' : '');
        $inRoot.prop('disabled', noBridge);
        $inLora.prop('disabled', noBridge);
        $btnPaths.prop('disabled', noBridge);
        $btnRefresh.prop('disabled', noBridge);
        $rowPaths.find('#tavern-img-browse-model, #tavern-img-browse-lora').prop('disabled', noBridge);
        $pathsCloudHint.text(noBridge ? '（无桥模式：模型清单由 ComfyUI 自动枚举，目录设置仅桥/本地 ComfyUI 需要）' : '（云部署的 ComfyUI 无需配置目录：模型清单由云端服务器自动提供）');
        // ③ API Key：无桥可填（存酒馆密钥库后隐藏）；不填则用酒馆主 API 密钥
        $inLlmKey.prop('disabled', false)
            .attr('title', '选填：填入后自动存入酒馆密钥库（隐藏存储），提示词请求即用此 key；不填则沿用酒馆主 API 的密钥')
            .attr('placeholder', noBridge ? 'API Key（选填）' : 'API Key（存桥本机，不回显）');
        // ③ 获取模型列表：桥/无桥都可用（无桥走酒馆服务端代理，读密钥库里的 key）
        $btnLlmModels.prop('disabled', false)
            .attr('title', '从该 API 获取模型列表（无桥模式：走酒馆代理，读你已存的 key）');
        // ⑧ 自定义工作流按钮区域不需要灰化（无桥也支持，见本地存储）
        // ⑤ LoRA：无桥 → 先自动枚举（同桥勾选 UI）；失败才手动输入
        if (noBridge) {
            $btnLoraRefresh.prop('disabled', false);
            $loraToggle.prop('disabled', false);
            $stLoraWrap.toggle(false);   // 先隐藏手动框，尝试自动
            fetchLorasViaComfy().then(ok => {
                if (ok) {
                    $stLoraWrap.toggle(false);
                    renderLoras({}, '', readCheckedLoras());
                    toastr.info('LoRA 已自动枚举（无桥·直连 ComfyUI）', '自动文生图');
                } else {
                    $stLoraWrap.toggle(true);        // 直连失败 → 回退手动输入
                    $loraToggle.prop('disabled', true);
                }
            }).catch(() => { $stLoraWrap.toggle(true); $loraToggle.prop('disabled', true); });
        } else {
            $loraToggle.prop('disabled', false);
            $btnLoraRefresh.prop('disabled', false);
            $stLoraWrap.toggle(false);
        }
    };

    // ── 通道感知状态刷新（每次通道变化 bridge/st/none 都调用）──
    function refreshLlmHint() {
        if (!connected) {
            // 无桥：只看 endpoint/模型 是否已填（key 走酒馆 secrets，不显示桥的 key 检测结果）
            if ($llmMode.val() === 'tavern') {
                $llmHint.text('🔑 主 API 就绪').css('color', '#8bc34a');
            } else {
                const ep = ($inLlmEndpoint.val() || '').trim();
                const mdl = ($inLlmModel.val() || '').trim();
                const sid = ((taGetLocalCfg().llm || {}).secretId || '').trim();
                $llmHint.text(ep && mdl ? (sid ? '🔑 已就绪（key 已存密钥库）' : '🔑 已就绪（无桥·本地）') : '🔑 待填写').css('color', ep && mdl ? '#8bc34a' : '');
                $inLlmKey.attr('placeholder', sid ? '••••••••（密钥已存酒馆密钥库，重新填写可更换）' : 'API Key（选填：填入后自动存入酒馆密钥库并隐藏；不填则用酒馆主 API 密钥）');
            }
            return;
        }
        // 桥模式：状态由 loadConfig（/config 的 key_configured）负责，这里不动
    }
    function refreshWfStatus() {
        if (!connected) {
            // 无桥：⑧ 绿勾/状态从本地 wf 配置读
            const lw = taGetLocalCfg().wf || {};
            const hasWf = !!(lw.wf && typeof lw.wf === 'object' && !Array.isArray(lw.wf) && Object.keys(lw.wf).length);
            $wfStatus.text(lw.enabled && hasWf ? '（自定义已启用）' : '（自动构建）').css('color', lw.enabled && hasWf ? '#8bc34a' : '');
        }
    }
    function refreshModeStats() {
        const n = Array.isArray(currentAutoModels) ? currentAutoModels.length : 0;
        $modeStats.html(!connected
            ? ('🟢 无桥模式（ST 代理） · 模型=' + n)
            : ('🔵 桥接模式 · 模型=' + n));
    }
    panelRefreshStatus = function () {
        checkComfyStatus();     // ② ComfyUI 连接状态（通道感知）
        refreshLlmHint();       // ③ LLM 状态
        refreshWfStatus();      // ⑧ 自定义工作流绿勾（无桥读本地）
        refreshModeStats();     // 底部通道+模型数状态行
    };

    $btn.on('click', async function () {
        const turnOn = !$btn.hasClass('on');   // 按当前视觉状态切换（switch 化后按钮无文本，不能再用 text 判断）
        if (!connected) {
            // 无桥模式：开关存本地；triggerOnce 出图前检查
            $btn.toggleClass('on', turnOn);
            $swState.text(turnOn ? '开启' : '关闭').css('color', turnOn ? '#8bc34a' : '#8a8f9e');
            taSetLocalCfg({ enabled: turnOn });
            toastr.success(turnOn ? '自动文生图已开启（无桥·本地）' : '自动文生图已关闭（酒馆只跑剧情不出图）', '自动文生图');
            return;
        }
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

    // 底部辅助行：📂 扩展目录 → 🧹 卸载桥 → ❓ 桥安装指南（无小字；标题行只留控制台+模式）
    const $rowAux = $('<div class="list-group-item" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 14px 0;padding:10px 14px;border-radius:12px;background:rgba(125,211,252,.05);border:1px solid rgba(125,211,252,.18);"></div>');
    $rowAux.append('<span id="ta-img-open-dir2" title="打开扩展文件夹（install.bat / 桥文件所在）" style="cursor:pointer;font-size:15px;color:#7dd3fc;padding:5px 12px;border-radius:8px;border:1px solid rgba(125,211,252,.4);white-space:nowrap;flex-shrink:0;">📂 扩展目录</span>');
    $rowAux.append('<span id="ta-img-uninstall2" title="卸载自动文生图桥（关闭出图引擎）&#10;&#10;点击后：&#10;① 删除酒馆 plugins 里的桥文件&#10;② 关闭 config.yaml 的 enableServerPlugins&#10;③ 自动重启酒馆。&#10;&#10;扩展本体保留不删；重新启用 = 运行扩展目录里的 install.bat。" style="cursor:pointer;font-size:15px;color:#f87171;padding:5px 12px;border-radius:8px;border:1px solid rgba(248,113,113,.4);white-space:nowrap;flex-shrink:0;">🧹 卸载桥</span>');
    $rowAux.append('<span id="ta-img-guide2" title="桥安装指南：桥=增强引擎（可选）" style="cursor:pointer;font-size:15px;color:#fbbf24;padding:5px 12px;border-radius:8px;border:1px solid rgba(251,191,36,.4);white-space:nowrap;flex-shrink:0;">❓ 桥安装指南</span>');
    $rowAux.on('click', '#ta-img-open-dir2', async function () {
        try {
            const r = await fetch(BRIDGE + '/open-dir', { method: 'POST' });
            const d = await r.json();
            if (!d.ok) throw new Error(d.error || '');
            toastr.info('已打开扩展目录（若没弹窗，按安装指南里的路径手动打开）', '自动文生图');
        } catch (e) {
            toastr.info('桥未启动，无法直接打开系统文件夹——点 ❓ 桥安装指南查看路径', '自动文生图');
        }
    });
    $rowAux.on('click', '#ta-img-uninstall2', async function () {
        if (!confirm('确定卸载桥？\n\n将执行：\n① 删除酒馆 plugins 里的桥文件\n② 关闭 enableServerPlugins\n③ 自动重启酒馆\n\n扩展本体保留；重新启用 = 双击扩展目录里的 install.bat。')) return;
        try {
            const r = await fetch(BRIDGE + '/uninstall', { method: 'POST' });
            const d = await r.json();
            if (d.ok) { toastr.success('桥已卸载，酒馆正在自动重启…（稍后刷新页面即可，出图功能已关闭）', '自动文生图'); }
            else { toastr.error('卸载失败：' + (d.error || ''), '自动文生图'); }
        } catch (e) {
            toastr.error('无法连接桥，请先确认桥已启动', '自动文生图');
        }
    });
    // 桥安装指南卡（初始隐藏；点 ❓ 展开/收起）
    const $guideBox = $('<div id="ta-img-guide-box" style="display:none;margin:8px 14px 0;padding:14px 16px;border-radius:12px;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.28);font-size:16px;line-height:1.9;color:#fde68a;"></div>');
    async function renderGuideCard() {
        const ch = await detectChannel().catch(() => 'st');
        const dir = await getMyExtInfo().catch(() => '');
        let html = '<div style="font-weight:700;margin-bottom:6px;color:#fbbf24;">🛠 桥安装指南</div>';
        if (ch === 'bridge') {
            html += '✅ 桥已安装（酒馆启动即自动运行）。<br>' +
                '• 出图引擎=桥：阶段提示 / 任务队列 / 自定义工作流 / 急停<br>' +
                '• 重装 / 换机器：到 <b>' + dir + '</b> 双击 install.bat<br>' +
                '• 卸载：点控制台 🧹 卸载桥（或 install.bat --uninstall）';
        } else {
            html += '📌 当前 = <b>无桥模式</b>（已能直接出图：主API提示词 → ComfyUI 代理 → 图片进酒馆）。<br>' +
                '💡 桥 = 可选增强引擎：阶段提示 / 任务队列 / 自定义工作流 / 急停。<br>' +
                '① 打开扩展目录（点上方 📂；弹不出来就复制下方路径）<br>' +
                '② 双击里面的 <b>install.bat</b>（自动：复制桥到 plugins/ → 开启 enableServerPlugins → 问你要不要重启酒馆）<br>' +
                '③ 重启后强刷页面，顶部胶囊变「✅ 已绑定 · 自动出图」<br>' +
                '<div style="margin-top:8px;word-break:break-all;background:rgba(0,0,0,.25);padding:8px 10px;border-radius:8px;">📁 ' + dir + '</div>';
        }
        $guideBox.html(html);
    }
    $rowAux.on('click', '#ta-img-guide2', async function () {
        await renderGuideCard();
        $guideBox.toggle();
    });
    $panel.append($guideBox);

    // 状态行（当前通道 + 模型数）：置于面板最上面（用户要求）——胶囊样式更醒目
    const $rowMode = $('<div class="list-group-item flex-container flexGap5" style="align-items:center;flex-wrap:wrap;margin:12px 14px 4px;padding:10px 14px;border-radius:12px;background:rgba(139,195,74,.06);border:1px solid rgba(139,195,74,.25);"></div>');
    const $modeStats = $('<span style="font-size:16px;color:#a5d6a7;white-space:nowrap;"></span>');
    $rowMode.append($modeStats);
    $panel.append($rowMode);

    // 简要使用指南：放在总开关行下方（一眼看到怎么用）
    const $rowHelp = $('<div class="list-group-item" style="margin:4px 14px 0;padding:10px 14px;border-radius:12px;background:rgba(129,140,248,.05);border:1px solid rgba(129,140,248,.20);font-size:14px;line-height:1.8;color:rgba(230,230,242,.75);"></div>');
    $rowHelp.html(
        '📖 <b style="color:#a5b4fc;">简要使用指南</b>　' +
        '① 打开总开关（上方）→ 聊天里角色每次回复自动配图；' +
        '② 模型可在「模型选择」里换（没选也行，自动挑稳定模型）；' +
        '③ 出图耗时 30 秒~几分钟，图直接落在回复下方；' +
        '④ 失败看红色提示，或点「停止任务」中断。' +
        '<span style="color:rgba(230,230,242,.45);">（提示词走酒馆主 API；无桥模式零安装直接出图）</span>'
    );

    // 按用户指定顺序重排（DOM 移动，不影响引用）：
    // 状态行置顶 → 总开关 → 简要指南 → 模型/LoRA目录 → 服务配置和API → 模型选择 → LoRA选择 → 速度档位；提示词规则置底；辅助行+指南卡
    [$rowMode, $stopRow, $rowHelp, $rowPaths, $rowCfg, $rowLLM, $rowAuto, $rowLora, $rowSpeed, $rowPrompt, $rowWf, $rowModel, $rowAux, $guideBox]
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
        try { applyChannelUI('bridge'); } catch (e) { /* 面板未构建时忽略 */ }
        try { panelRefreshStatus(); } catch (e) { /* 忽略 */ }
        // 恢复桥状态胶囊（若之前显示的是无桥样式）
        try {
            const $bs0 = $('#ta-img-bind');
            if ($bs0.length && $bs0.text().includes('无桥')) {
                $bs0.html('<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#8bc34a;box-shadow:0 0 8px #8bc34a;animation:pulse 1.6s infinite;"></span>✅ 已绑定 · 自动出图</span>')
                    .css('background', 'rgba(139,195,74,.12)').css('border', '1px solid rgba(139,195,74,.4)').css('color', '#8bc34a');
            }
        } catch (e) { /* 忽略 */ }
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
async function getMyExtInfo() {
    // 问酒馆服务器：扩展管理器 discover 接口返回扩展清单 [{type,name}]
    try {
        const r = await fetch('/api/extensions/discover');
        const list = await r.json();
        const mine = (Array.isArray(list) ? list : []).find(x => /tavern-auto-img/i.test(x.name || ''));
        if (mine) {
            if (mine.type === 'local') return `酒馆目录/data/default-user/extensions/${mine.name.replace(/^third-party\//, '')}`;
            if (mine.type === 'global') return `酒馆目录/public/scripts/extensions/${mine.name}`;
            return `酒馆目录/public/scripts/extensions/${mine.name}`;
        }
    } catch (e) { /* 忽略 */ }
    return '酒馆目录/data/default-user/extensions/tavern-auto-img-extension';
}
async function showBridgeHelp() {
    bridgeHelpShown = true;
    // 探测通道 → 刷新面板状态（每次通道变化都对齐：桥/无桥各自的检测结果）
    const ch = await detectChannel();
    try { applyChannelUI(ch === 'bridge' ? 'bridge' : 'st'); } catch (e) { /* 忽略 */ }
    try { panelRefreshStatus(); } catch (e) { /* 忽略 */ }
    // 顶部胶囊：无桥 → 「🟢 无桥模式·自动出图（ST 代理）」；恢复桥 → 「已绑定·自动出图」
    try {
        const $bs = $('#ta-img-bind');
        if ($bs.length) {
            if (ch === 'st') {
                $bs.html('<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#67e8f9;box-shadow:0 0 8px #67e8f9;animation:pulse 1.6s infinite;"></span>🟢 无桥模式 · 自动出图（ST 代理）</span>')
                    .css('background', 'rgba(103,232,249,.12)').css('border', '1px solid rgba(103,232,249,.4)').css('color', '#67e8f9')
                    .attr('title', '无桥模式已就绪（ST 原生代理）' +
                        '&#10;&#10;出图走：酒馆主 API（提示词工程）→ ComfyUI 代理 → 图片存酒馆。不需要装桥！' +
                        '&#10;面板中依赖桥的项（模型目录 / LoRA 枚举 / API Key / 获取模型列表）已灰化，其余选项无桥直接可用。' +
                        '&#10;可选：安装 install.bat 桥可获得 阶段提示/任务队列 等增强功能。');
            } else if (ch === 'bridge' && $bs.text().includes('无桥')) {
                $bs.html('<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#8bc34a;box-shadow:0 0 8px #8bc34a;animation:pulse 1.6s infinite;"></span>✅ 已绑定 · 自动出图</span>')
                    .css('background', 'rgba(139,195,74,.12)').css('border', '1px solid rgba(139,195,74,.4)').css('color', '#8bc34a')
                    .attr('title', '桥已绑定成功。' +
                        '&#10;&#10;出图走：桥（酒馆服务端插件）→ ComfyUI → 图片存酒馆。' +
                        '&#10;桥提供：阶段提示 / 任务队列 / 自定义工作流 / 急停等增强功能。');
            }
        }
    } catch (e) { /* 忽略 */ }
    // 状态说明已收进胶囊悬停提示（tooltip）；不再插入整块横幅占面板空间
    if (ch !== 'st') {
        const $h = $('#ta-img-bridge-help');
        if (!$h.length) {
            const myDir = await getMyExtInfo();
        $('<div id="ta-img-bridge-help" style="background:rgba(224,85,85,.10);border:1px solid rgba(224,85,85,.45);border-radius:12px;padding:12px 14px;margin-bottom:10px;font-size:16px;color:#ffb4b4;">' +
          '<div style="font-weight:700;margin-bottom:6px;">⚠️ 桥未启动（出图功能不可用）</div>' +
          '<div style="margin-bottom:8px;line-height:1.7;">桥 = 发动机，随酒馆自动运行。没检测到它可能还没安装：</div>' +
          '<ol style="margin:0 0 8px 18px;line-height:1.7;">' +
          '<li>桥文件和 install.bat 已随本扩展下载，位置：<br><b style="color:#7dd3fc;word-break:break-all;">' + myDir + '</b></li>' +
          '<li>打开那个文件夹 → 双击 <b>install.bat</b>（自动：复制桥到 plugins/ + 开开关 + 问你要不要重启酒馆）</li>' +
          '<li>完成后强刷本页面，这条提示自动消失</li>' +
          '</ol>' +
          '</div>').insertAfter($('#ta-img-card .list-group-item').first());
        }
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
    pendingImgTarget = msg;   // 图片附加到这条角色回复下方（桥/无桥两端都设）
    if (seenMessages.size > 100) {
        const first = seenMessages.values().next().value;
        seenMessages.delete(first);
    }
    const text = (msg.mes || msg.message || '').trim();
    if (!text) return;
    console.log('[tavern-auto-img] 收到角色回复, 触发自动文生图, id=', msg.id);
    // 通道选择：桥活着 → 桥；桥没起 → ST 原生代理（无桥模式）；都没有 → 提示装桥
    const channel = await detectChannel();
    if (channel !== 'none') addImgPlaceholder(msg.id);   // 触发即占位（正在生成图…）
    if (channel === 'st') {
        // 无桥模式总开关（本地存储）：关闭时跳过并提示
        if ((taGetLocalCfg().enabled ?? true) === false) {
            toastr.warning('自动文生图总开关已关闭（⚡ 控制台顶栏开关），本次跳过出图', '自动文生图');
            return;
        }
        try {
            await generateViaST(text, msg.name || '角色');
        } catch (e) {
            console.error('[tavern-auto-img] 无桥模式失败:', e);
            const stack = (e && e.stack ? e.stack.split('\n').slice(0, 4).map(s => s.trim()).join(' ← ') : (e?.message || '未知错误'));
            showError({ message: (e?.message || '无桥模式出图失败') + ' | ' + stack });
        }
        return;
    }
    if (channel === 'none') {
        showError({ message: '桥未启动，且 ComfyUI 代理不可用。请在控制台按提示装桥（install.bat）或检查 ComfyUI 地址' });
        return;
    }
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
                // 无桥模式：胶囊追加通道标识（桥模式文本不变）
                if (!connected) {
                    detectChannel().then(ch => {
                        const $b2 = $('#ta-img-bind');
                        if (ch === 'st' && $b2.length) {
                            $b2.html('<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#67e8f9;box-shadow:0 0 8px #67e8f9;animation:pulse 1.6s infinite;"></span>🟢 无桥模式 · 自动出图（ST 代理）</span>')
                                .css('background', 'rgba(103,232,249,.12)').css('border', '1px solid rgba(103,232,249,.4)').css('color', '#67e8f9');
                        }
                    });
                }
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

// 页面错误捕手：任何未捕获 JS 错误 → 控制台红条显示（方便定位，无需 F12）
window.addEventListener('error', function (ev) {
    try {
        const msg = (ev && (ev.message || (ev.error && ev.error.message))) || '未知错误';
        const fn = (ev && ev.error && ev.error.stack || '').split('\n')[1] || '';
        console.error('[tavern-auto-img] 页面错误:', ev.error || msg);
        toastr.error('⚠️ ' + String(msg).slice(0, 120) + '　' + String(fn).slice(0, 40), '自动文生图·错误捕手');
    } catch (e) { /* 忽略 */ }
});
window.addEventListener('unhandledrejection', function (ev) {
    try {
        const msg = (ev && ev.reason && (ev.reason.message || ev.reason)) || '未知 Promise 错误';
        console.error('[tavern-auto-img] 未处理 Promise 拒绝:', ev.reason);
        toastr.error('⚠️ ' + String(msg).slice(0, 120), '自动文生图·错误捕手');
    } catch (e) { /* 忽略 */ }
});

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    window.addEventListener('load', init);
}
