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
    sdxl: { checkpoint: true, latent: ['EmptyLatentImage', 4], sampler: 'euler', scheduler: 'normal', steps: 28, cfg: 7.0, width: 832, height: 1216 },
};
function stBuildWorkflow(modelFile, family, loras, wNum, hNum, stepsNum, positive, negative) {
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
    const w = Math.max(64, Math.round((wNum || rec.width) / 8) * 8);
    const h = Math.max(64, Math.round((hNum || rec.height) / 8) * 8);
    const steps = Math.max(1, parseInt(stepsNum || rec.steps, 10) || rec.steps);
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
async function stEngineer(text, family, myEpoch) {
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
    // ⭐ 自动重试：LLM API 偶发不通（498/499/500/超时/空内容）→ 重试最多 3 次，并非每次都要用户看到红 toast
    let j = null, r = null, lastErr = '';
    const epochAlive = function () { return (typeof myEpoch !== 'number') || taGenEpoch === myEpoch; };
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (!epochAlive()) { const e = new Error('任务已被接管（重跑/重发/切卡）'); e.name = 'AbortError'; throw e; }   // ⭐ 纪元过期=立即自杀（防与手动重跑打架）
        if (attempt > 1) {
            const waitMs = attempt === 2 ? 2500 : 3500;
            console.log('[ta-img][diag] 提示词 LLM 第' + attempt + '次重试（' + waitMs + 'ms 后）…');
            await new Promise(resv => setTimeout(resv, waitMs));
            if (!epochAlive()) { const e = new Error('任务已被接管'); e.name = 'AbortError'; throw e; }
        }
        try {
            r = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
                signal: stAbort ? stAbort.signal : undefined,
            });
            j = await r.json();
            lastErr = String(j?.error?.message || 'LLM 调用失败 ' + r.status);
            if (r.ok && (j?.choices?.[0]?.message?.content || '').trim().length > 0) break;
            console.log('[ta-img][diag] 提示词 LLM 第' + attempt + '次未达标：status=' + r.status + ' content=' + String(j?.choices?.[0]?.message?.content || '').length);
            if (attempt === 3) { /* 最后一次：走出循环走报错 */ }
        } catch (e) {
            lastErr = String(e.message || e);
            console.log('[ta-img][diag] 提示词 LLM 第' + attempt + '次异常：' + lastErr);
        }
    }
    if (!r || !r.ok) {
        console.log('[ta-img][diag] 提示词 LLM 失败（重试后）：status=', r ? r.status : '(网络异常)', '| 响应=', JSON.stringify(j || {}).slice(0, 300));
        taLogRun({ llm: '❌ HTTP ' + (r ? r.status : '网络') + '：' + String(lastErr).slice(0, 80) });
        throw new Error(String(lastErr));
    }
    const content = j?.choices?.[0]?.message?.content || '';
    if (!content.trim()) {
        console.log('[ta-img][diag] 提示词 LLM 重试 3 次后内容仍为空'); 
        taLogRun({ llm: '❌ 重试 3 次后内容为空' });
        throw new Error('LLM 返回空内容（已重试 3 次）');
    }
    console.log('[ta-img][diag] 提示词返回：content长度=', content.length, '| 前80字=', content.slice(0, 80).replace(/\n/g, ' '));
    taLogRun({ llm: '✅ ' + llmModel + ' content=' + content.length + '字' });
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
async function generateViaST(text, name, lock) {
    const myEpoch = ++taGenEpoch;   // ⭐ 任务纪元号：本任务领取号码；被中断/被接管时旧任务自杀
    console.log('[ta-img][st] ① 进入无桥出图', { textLen: (text || '').length, name, epoch: myEpoch });
    const localCfg = taGetLocalCfg();
    const runStart = Date.now();
    taLogRun({ channel: '🟢 无桥(ST代理)', model: '', family: '', positive: '', negative: '', status: '⏳ 进行中' });
    let modelFile = (autoModelSel?.val() || '').trim() || (modelSel?.val() || '').trim();
    if (!modelFile) modelFile = (localCfg.auto_model || '').trim();   // 面板未加载时从本地兜底
    const family = modelFile ? stDetectFamily(modelFile) : 'anima';
    taLogRun({ model: modelFile, family: family });
    // LoRA：面板勾选优先；无勾选时用无桥手动清单（localStorage）
    let loras = loraBox ? Array.from(loraBox.find('input[type=checkbox]:checked')).map(c => c.getAttribute('data-file') || '') : [];
    if (!loras.length && Array.isArray(localCfg.loras)) loras = localCfg.loras;
    const fNum = (s, d) => { const n = parseFloat(s); return isFinite(n) ? n : d; };
    // 速度档位（2026-09-06 v3）：直接输入步数/宽高；留空=用该模型家族推荐值（推荐随模型变化）
    const recNow = ST_RECIPES[family] || ST_RECIPES['anima'];
    const stepsN = parseInt((document.getElementById('tavern-img-steps')?.value || ''), 10) || (localCfg.steps_num != null ? localCfg.steps_num : recNow.steps);
    const wN = parseInt((document.getElementById('tavern-img-width')?.value || ''), 10) || (localCfg.w_num != null ? localCfg.w_num : recNow.width);
    const hN = parseInt((document.getElementById('tavern-img-height')?.value || ''), 10) || (localCfg.h_num != null ? localCfg.h_num : recNow.height);
    taLogRun({ steps: stepsN, size: wN + 'x' + hN });
    let comfyUrl = (document.getElementById('tavern-img-comfy')?.value || '').trim() || (localCfg.comfy_url || '').trim() || 'http://127.0.0.1:8188';
    comfyUrl = comfyUrl.replace(/\/+$/, '');

    toastr.info('🤖 提示词生成中…（无桥模式·走酒馆主 API）', '自动文生图');
    // ⭐ 被接管（AbortError）原样抛（triggerOnce 静默）；其它失败才包前缀
    const pr = await stEngineer(text, family, myEpoch).catch(e => {
        if (e && e.name === 'AbortError') throw e;
        throw new Error('提示词生成失败:' + e.message);
    });
    if (taGenEpoch !== myEpoch) { const e = new Error('任务已被接管'); e.name = 'AbortError'; throw e; }   // ⭐ 纪元自查
    const negative = 'bad quality, worst quality, lowres, blurry, extra limbs, deformed hands, text, watermark'
        + (pr.male ? ', female, woman, girl, big breasts, cleavage, westerner, caucasian' : '');
    taLogRun({ positive: pr.positive, negative: negative, promptOk: true });
    toastr.info('✅ 提示词完成，开始生图…', '自动文生图');

    // 自定义工作流优先：已启用且粘贴了 API JSON → 替换占位符后直接用（模型/参数由 JSON 决定）
    const wfCfg = localCfg.wf || {};
    const useCustomWf = !!(wfCfg.enabled && wfCfg.wf && typeof wfCfg.wf === 'object' && !Array.isArray(wfCfg.wf) && Object.keys(wfCfg.wf).length);
    if (!useCustomWf && !modelFile) throw new Error('未选择模型（在控制台④ 模型选择里挑一个）');
    if (!useCustomWf) await stPreflight(family, comfyUrl);   // 自适应模式：节点+CLIP/VAE 前置体检
    const lorasArr = loras.map(f => [f, 0.8, 0.8]);
    const wf = useCustomWf
        ? applyWfCustom(wfCfg.wf, pr.positive, negative)
        : stBuildWorkflow(modelFile, family, lorasArr, wN, hN, stepsN, pr.positive, negative);

    // ── 直连 ComfyUI：POST /prompt → WS 事件等完成 → /history 取图（零轮询）──
    stAbort = new AbortController();
    const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (taGenEpoch !== myEpoch) { const e = new Error('任务已被接管'); e.name = 'AbortError'; throw e; }   // ⭐ 纪元自查
    const r = await fetch(comfyUrl + '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: wf, client_id: clientId }),
        signal: stAbort.signal,
    });
    console.log('[ta-img][st] ⑤ 直连提交 ComfyUI /prompt', r.status);
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error('ComfyUI 提交失败: ' + t.slice(0, 200));
    }
    const sub = await r.json();
    const pid = sub.prompt_id;
    if (!pid) throw new Error('ComfyUI 未返回 prompt_id');
    await waitComfyDirect(comfyUrl, pid, clientId, stAbort.signal, 240000);   // 事件驱动（WS），非轮询
    if (taGenEpoch !== myEpoch) { const e = new Error('任务已被接管'); e.name = 'AbortError'; throw e; }   // ⭐ 纪元自查
    // 完成后一次性 /history 取图（WS 消息可能早于落盘 → 小重试 3 次，命中即停）
    let hist = {}, imgMeta = null;
    for (let attempt = 0; attempt < 3 && !imgMeta; attempt++) {
        try {
            hist = await (await fetch(comfyUrl + '/history/' + pid, { signal: stAbort.signal })).json();
            const node = (hist[pid] || {});
            for (const [_nid, nout] of Object.entries(node.outputs || {})) {
                const imgs = nout.images || [];
                if (imgs && imgs.length) { imgMeta = imgs[0]; break; }
            }
        } catch (e) { /* 忽略，继续 */ }
        if (!imgMeta && attempt < 2) await new Promise(r => setTimeout(r, 600));
    }
    if (!imgMeta) throw new Error('完成但未找到输出图');
    const vUrl = comfyUrl + '/view?' + new URLSearchParams({ filename: imgMeta.filename, subfolder: imgMeta.subfolder || '', type: imgMeta.type || 'output' });
    const vr = await fetch(vUrl, { signal: stAbort.signal });
    if (!vr.ok) throw new Error('取图失败 HTTP ' + vr.status);
    const buf = await vr.arrayBuffer();
    console.log('[ta-img][st] ⑥ 直连拿到 base64，上传中…');
    const fmt = ((imgMeta.filename || '').match(/\.([a-z0-9]+)$/i)?.[1] || 'png').toLowerCase();
    const fname = 'tavern_auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const url = await saveBase64AsFile(bufToBase64(buf), (name || '生图').replace(/[\\/]/g, '_'), fname, fmt);
    console.log('[ta-img][st] ⑦ 上传成功，url =', url);
    taLogRun({ status: '✅ 成功', secs: Math.round((Date.now() - runStart) / 1000), url: url }, true);
    showImage({ url: url, name: name, model: modelFile }, lock);
    console.log('[ta-img][st] ⑧ showImage 调用完成');
    return url;
}

/** 直连 ComfyUI WS：等自己的 prompt 完成（事件驱动；executing/executed/error 按 prompt_id 分流） */
function waitComfyDirect(comfyUrl, pid, clientId, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
        let ws = null, done = false;
        const timer = setTimeout(() => finish(new Error('生成超时（WS 无完成信号）'), true), timeoutMs);
        const fin = (err) => { if (done) return; done = true; clearTimeout(timer); try { signal && signal.removeEventListener('abort', onAbort); } catch { /* 忽略 */ } try { ws && ws.close(); } catch { /* 忽略 */ } err ? reject(err) : resolve(); };
        const onAbort = () => fin(new Error('已中断'));
        if (signal) { if (signal.aborted) { fin(new Error('已中断')); return; } signal.addEventListener('abort', onAbort); }
        function finish(err) { fin(err); }
        try {
            const wsUrl = comfyUrl.replace(/^http/, 'ws') + '/ws?clientId=' + encodeURIComponent(clientId);
            ws = new WebSocket(wsUrl);
            ws.onopen = () => console.log('[ta-img][st] WS 已连接（事件驱动，非轮询）', pid);
            ws.onmessage = (evt) => {
                let m; try { m = JSON.parse(evt.data); } catch { return; }
                if (!m || !m.data) return;
                if (m.type === 'executing' || m.type === 'progress' || m.type === 'executed') {
                    if (m.data.prompt_id && m.data.prompt_id !== pid) return;   // 只认自己，天然不打架
                }
                if (m.type === 'execution_success' || m.type === 'execution_complete') { finish(); }
                else if (m.type === 'executed' && m.data.output && m.data.output.images && m.data.output.images.length) { finish(); }   // 输出节点完成=有图
                else if (m.type === 'execution_error') { finish(new Error('ComfyUI 执行错误：' + String(m.data?.exception_message || '').slice(0, 200))); }
                else if (m.type === 'execution_interrupted') { finish(new Error('任务被中断')); }
            };
            ws.onerror = () => console.warn('[ta-img][st] WS 连接错误（若任务已提交，稍后走结束信号）');
            ws.onclose = () => { /* 正常关闭由 finish 处理 */ };
        } catch (e) { finish(new Error('WS 建立失败：' + (e.message || e))); }
    });
}
/** ArrayBuffer → base64（浏览器） */
function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
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
function addImgPlaceholder(el, msgName) {
    let $el = (el && el.isConnected) ? $(el) : $();
    if (!$el.length && msgName) $el = $('.mes[ch_name="' + msgName + '"]').last();   // 按角色名找本次回复
    if (!$el.length) $el = $('.mes[is_user="false"]').last();
    if (!$el.length) return;                          // 聊天区无消息：跳过（不阻断出图）
    if ($el.find('.ta-img-ph').length) return;        // 已有占位不重复（该楼层的）
    injectTaSpinKeyframes();
    // ⭐ 占位符样式补按钮（按钮不覆盖/不换行：小圆角，醒目但不抢戏）
    if (!window.__taRerunCss) {
        window.__taRerunCss = true;
        $('head').append('<style>.ta-img-rerun{margin-left:auto;flex-shrink:0;cursor:pointer;background:rgba(129,140,248,.16);color:#a5b4fc;border:1px solid rgba(129,140,248,.45);border-radius:8px;padding:4px 10px;font-size:13px;white-space:nowrap}.ta-img-rerun:hover{background:rgba(129,140,248,.3);color:#c7d2fe}</style>');
    }
    const $txt = $el.find('.mes_text').last();
    const html = '<div class="ta-img-ph"><span class="ta-img-spin"></span><span>自动文生图：正在生成图…（完成后自动显示）</span><button class="ta-img-rerun" title="提示词不满意/卡壳时点它：重新生成提示词并重新出图">🔄 重新生成提示词</button></div>';
    if ($txt.length) {
        $txt.after(html);   // 统一文本下方（用户偏好：图在剧情文本下面）
    } else {
        $el.append(html);
    }
    console.log('[ta-img][diag] 占位符已插入（楼层=', (el && el.isConnected ? '锚定' : '找回'), '）');
}
// ⭐ 占位符旁「重新生成提示词」按钮：一键重跑（重新调 LLM 出题 + 重新出图），绑在当前任务的楼层上
function taRerunPrompt() {
    const job = taLastJob;
    if (!job) { toastr.warning('还没有可重跑的出图任务（先发一条消息触发一次）', '自动文生图'); return; }
    if (window.__taRerunBusy) return;
    window.__taRerunBusy = true;
    (async () => {
        try {
            console.log('[ta-img][diag] 手动「重新生成提示词」→ 全链重跑（LLM 出题→直连出图）');
            taInterruptImageTask();
            const channel = await detectChannel();
            if (channel === 'st') await generateViaST(job.text, job.name || '角色', job.lock);
            else if (channel === 'bridge') await generateViaBridge(job.text, job.name || '角色', job.lock);
            else showError({ message: '重跑失败：ComfyUI 通道不可用（检查 ComfyUI 地址/桥）' });
        } catch (e) {
            console.error('[tavern-auto-img] 重新生成失败:', e);
            taLogRun({ status: '❌ 重跑失败', error: (e?.message || '未知错误') }, true);
            if (!(e && (e.name === 'AbortError' || /abort|已被接管/i.test(String(e.message || ''))))) {
                showError({ message: '重新生成提示词失败：' + (e?.message || '未知错误') });
            }
        } finally {
            window.__taRerunBusy = false;
        }
    })();
}
if (!window.__taRerunBound) {
    window.__taRerunBound = true;
    $(document).on('click', '.ta-img-rerun', function () { taRerunPrompt(); });
}
function replaceImgPlaceholder(url, el) {
    // 占位符=图槽：原地把占位符换成成品图（绑定该楼层，不删重插、位置不变）
    const $p = (el && el.isConnected) ? $(el).find('.ta-img-ph').first() : $('.ta-img-ph').first();
    if (!$p.length) return false;
    $p.replaceWith('<img class="ta-img-real" src="' + url + '" style="max-width:480px;display:block;height:auto;border-radius:12px;margin:6px 0 10px;">');
    console.log('[ta-img][diag] 占位符→成品图（同楼层原位替换）');
    return true;
}
function removeImgPlaceholder(el) {
    if (el && el.isConnected) $(el).find('.ta-img-ph').remove();
    else $('.ta-img-ph').remove();
}

// 出图运行日志：每次触发记录（提示词/模型/耗时/结果），localStorage 滚动 50 条，面板可查
let taCurrentRun = null;
function taLogRun(partial, finalize) {
    try {
        if (!taCurrentRun) taCurrentRun = { ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }), steps: [] };
        Object.assign(taCurrentRun, partial);
        if (finalize) {
            const arr = JSON.parse(localStorage.getItem('taImgRunLogs') || '[]');
            arr.unshift(taCurrentRun);
            if (arr.length > 50) arr.length = 50;
            localStorage.setItem('taImgRunLogs', JSON.stringify(arr));
            taCurrentRun = null;
        }
    } catch (e) { /* 忽略 */ }
}
function taGetRunLogs() {
    try { return JSON.parse(localStorage.getItem('taImgRunLogs') || '[]'); } catch (e) { return []; }
}

// 中断当前出图任务（包括提示词 LLM 与 ComfyUI 排队/生成中的任务）
async function taInterruptImageTask() {
    taGenEpoch++;   // ⭐ 纪元号+1：旧任务（含 LLM 重试循环/WS 等待）全部自杀，绝不与新任务并发打架
    try {
        // ① 无桥：中止前端 fetch（提示词/代理请求立即停）
        if (stAbort && !stAbort.signal.aborted) {
            try { stAbort.abort(); } catch (e) { /* 忽略 */ }
        }
        // ② 真中断 ComfyUI 任务：直连 /interrupt（ComfyUI 已开 CORS）
        const comfyUrl = ((document.getElementById('tavern-img-comfy')?.value || '').trim() || (taGetLocalCfg().comfy_url || 'http://127.0.0.1:8188')).replace(/\/+$/, '');
        try { await fetch(comfyUrl + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch (e) { /* ComfyUI 未起/拒绝即忽略 */ }
        // ③ 桥模式：桥端移除队列任务
        if (connected) {
            try { await fetch(BRIDGE + '/cancel', { method: 'POST' }); } catch (e) { /* 忽略 */ }
        }
        console.log('[tavern-auto-img] 已触发中断（重roll/编辑）');
    } catch (e) { /* 忽略 */ }
}

// 已显示过的图片 url（防重复投递/重复连接导致重复消息）
const shownImages = new Set();


function showImage(data, lock) {
    try {
        const url = data.url || data.image;
        console.log('[ta-img][st] ⑨ showImage 进入, url=', url);
        if (!url) return;
        // 三重防重：同 url 已显示 → 跳过（不管谁重复投递）
        if (shownImages.has(url)) return;
        shownImages.add(url);
        // 有占位符 → 占位符=图槽：原地替换成图（绑定楼层；消息快也不串楼层）
        const replaced = replaceImgPlaceholder(url, lock && lock.el);
        // 兜底：chat 里已存在同 url 消息 → 跳过
        const ctx = getCtx();
        if (ctx && ctx.chat && ctx.chat.some(m => m.extra && m.extra.media && m.extra.media.some(x => x.url === url))) { if (replaced) toastr.success('✨ 已生成图片', '自动文生图'); return; }
        // ── 附加到目标角色消息（不新增消息）────────────────────
        // 绑定定死：图自带任务锁 lock。优先用【楼层锚】（触发时抓住的 .mes 元素）→ 原地放图；
        // 楼层失效时再按 消息对象引用 / send_date+文本头 匹配；都失败=不错挂（图文件保留）
        let target = null;
        let $el = null;
        if (lock && lock.el && lock.el.isConnected) {
            // ① 楼层锚（主）：元素还在页面上 → 直接用这一层
            $el = $(lock.el);
            if (ctx && ctx.chat) {
                const nm = $el.attr('ch_name') || '';
                const idx = $('.mes[is_user="false"]').index($el);
                const list = ctx.chat.filter(m => m && !m.is_user && !m.is_system);
                if (idx >= 0 && list[idx]) target = list[idx];   // 楼层序号 → chat 对应消息（数据层）
                if (!target && nm) target = ctx.chat.find(m => m && !m.is_user && String(m.name || '') === nm) || null;
            }
            if (!target) console.log('[ta-img][diag] 楼层锚在但数据配对失败（idx/名字），仍就地显示图');
        }
        if (ctx && ctx.chat) {
            if (!target && lock && lock.msg && ctx.chat.some(m => m === lock.msg)) target = lock.msg;   // ② 对象引用直配
            if (!target && lock && lock.sendDate) {   // ③ send_date+trim文本头 匹配（重roll/编辑后对象被替换时）
                const sd = String(lock.sendDate);
                const hd = String(lock.head || '').trim();
                target = ctx.chat.find(m => m && !m.is_user && !m.is_system && String(m.send_date || '') === sd && String(m.mes || '').trim().slice(0, 40) === hd) || null;
                if (!target) target = ctx.chat.find(m => m && !m.is_user && !m.is_system && String(m.send_date || '') === sd) || null;
            }
            if (!target && pendingImgTarget && ctx.chat.some(m => m === pendingImgTarget)) target = pendingImgTarget;   // ④ 兼容
            if (!target && !lock) {   // ⑤ 无 lock（桥兼容端点）→ 最后一条角色回复（旧行为）
                for (let i = ctx.chat.length - 1; i >= 0; i--) {
                    const m = ctx.chat[i];
                    if (!m) continue;
                    const nm = String(m.name || '').toLowerCase();
                    if (!m.is_user && !m.is_system && !nm.includes('生图') && !nm.includes('文生图')) { target = m; break; }
                }
            }
        }
        // 楼层锚失效且消息也没找到 → 不错挂（图文件保留）
        if (!target && lock) {
            console.warn('[ta-img][diag] 目标消息已不在聊天中/被替换，跳过挂载 url=', url, 'lock=', lock.sendDate);
            toastr.info('图已生成，但对应回复已变化，未挂载', '自动文生图');
            return;
        }
        // 楼层锚无效时才用数据层找元素（虚拟滚动可能重建元素：mesid/ch_name/最后一条）
        if (target && !$el) {
            $el = $('.mes[mesid="' + target.id + '"]');
            if (!$el.length && target.name) $el = $('.mes[ch_name="' + target.name + '"]').last();
            if (!$el.length) $el = $('.mes[is_user="false"]').last();
        }
        if (target) {
            target.extra = target.extra || {};
            target.extra.media = target.extra.media || [];
            if (!target.extra.media.some(x => x.url === url)) {
                target.extra.media.push({ url: url, type: 'image', title: data.model || '' });
                const isAnchor = lock && lock.el && lock.el.isConnected;
                console.log('[ta-img][diag] showImage 挂载目标=', (target && target.el) ? (target.el.className || 'mes元素') : (target && target.name || '?'), '| replaced=', replaced, '| elLen=', $el.length, '| 消息名=', target.name || '', '| 楼层/', isAnchor ? '锚定' : '找回', '| chat 最后=', (getCtx()?.chat?.length ?? -1));
                // 视觉：占位符=图槽已原位替换（replaced=true）→ 完成；
                // 否则（占位符被ST清/丢失）→ 在该楼层媒体区/尾部补插一张（图槽兜底，绝不错层）
                if (!replaced) {
                    const $cam = $el.length ? $el : (isAnchor ? $(lock.el) : $());
                    const $w = $cam.find('.mes_media_wrapper');
                    const imgHtml = '<img class="ta-img-real" src="' + url + '" style="max-width:480px;display:block;height:auto;border-radius:12px;margin:6px 0 10px;">';
                    if ($w.length) {
                        if (!$w.find('img[src="' + url + '"]').length) $w.append(imgHtml);
                        console.log('[ta-img][diag] 图槽兜底：媒体区补插完成');
                    } else if ($cam.length) {
                        $cam.append(imgHtml);
                        console.log('[ta-img][diag] 图槽兜底：楼层尾部补插完成');
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

    // ③ 速度档位（v3：直接输入步数/分辨率；留空=自动用该模型推荐，推荐随所选模型自动变化）
    const $rowSpeed = mkRow('fa-bolt', '速度档位：');
    const $stepsNum = $('<input id="tavern-img-steps" type="number" min="0" max="120" step="1" placeholder="自动" style="width:66px;font-size:16px;text-align:center;" title="生成步数：留空=自动用推荐值。越少越快、越多越细">');
    const $wNum = $('<input id="tavern-img-width" type="number" min="32" max="2048" step="8" placeholder="自动" style="width:82px;font-size:16px;text-align:center;" title="画面宽：留空=自动用推荐值">');
    const $hNum = $('<input id="tavern-img-height" type="number" min="32" max="2048" step="8" placeholder="自动" style="width:82px;font-size:16px;text-align:center;" title="画面高：留空=自动用推荐值">');
    const $stepsLab = $('<span class="muted" style="margin-right:6px;">步数</span>');
    const $sizeLab = $('<span class="muted" style="margin-right:6px;">分辨率</span>');
    const $recHint = $('<span class="muted" name="ta-img-rec-hint" style="margin-left:8px;font-size:14px;color:#93c5fd;white-space:nowrap;" title="推荐值来自当前所选模型对应的家族（kodoranime=SDXL…），选模型后自动更新。直接输入会用你的值。"></span>');
    // 顺序：步数 → 宽×高 → 推荐
    $rowSpeed.append($stepsLab, $stepsNum, $sizeLab, $wNum, $('<span class="muted">×</span>'), $hNum, $recHint);
    $panel.append($rowSpeed);

    // ④ 模型目录自选（extra_model_paths 管理）
    const $rowPaths = mkRow('fa-folder-open', '模型 / LoRA 目录：');
    // 两个按钮（占位更小、无输入框）：点击弹出内置目录选择浮层
    let taModelRoot = '', taLoraRoot = '';
    const $btnRootPick = $('<button id="tavern-img-browse-model" class="menu_button" style="min-width:150px;font-size:16px;white-space:nowrap;" title="模型存放位置：模型/LoRA 文件下载到哪，就选哪">📂 模型存放位置</button>');
    const $btnLoraPick = $('<button id="tavern-img-browse-lora" class="menu_button" style="min-width:150px;font-size:16px;white-space:nowrap;" title="LoRA 存放位置：上面是 ComfyUI 默认位置，点这里选">📂 LoRA 存放位置</button>');
    const $btnPaths = $('<button id="tavern-img-paths-save" class="menu_button" style="min-width:92px;font-size:15px;white-space:nowrap;">💾 保存</button>');
    const $btnRefresh = $('<button id="tavern-img-refresh-list" class="menu_button" style="min-width:92px;font-size:15px;white-space:nowrap;">🔄 刷新</button>');
    const $pathsHint = $('<span class="muted" style="margin-left:6px;font-size:15px;width:100%;"></span>');
    const $pathsCloudHint = $('<span class="muted" style="font-size:14px;width:100%;margin-top:2px;">（模型/LoRA 下载到哪，就把存放位置选到哪；上方列表是 ComfyUI 默认位置）</span>');
    const $inRoot = $('<input id="tavern-img-paths-root" type="hidden">');
    const $inLora = $('<input id="tavern-img-paths-lora" type="hidden">');
    function syncPathButtons() {
        $btnRootPick.attr('title', '模型存放位置：' + (taModelRoot || '未设置（用 ComfyUI 默认）'));
        $btnRootPick.css('color', taModelRoot ? '' : '#8a8f9e');
        $btnLoraPick.attr('title', 'LoRA 存放位置：' + (taLoraRoot || '未设置（用 ComfyUI 默认）'));
        $btnLoraPick.css('color', taLoraRoot ? '' : '#8a8f9e');
        $inRoot.val(taModelRoot); $inLora.val(taLoraRoot);
    }
    syncPathButtons();
    // 目录浏览按钮：改前端内置目录选择浮层（酒馆页面内，永远置顶；系统弹窗在后台进程下不可靠）
    // 候选 = 桥 /list-models 枚举出的目录（去重） + 当前输入 + 手动输入
    const $dirOv = $('<div id="ta-img-dir-ov" style="position:fixed;inset:0;z-index:10080;display:none;background:rgba(0,0,0,.65);align-items:center;justify-content:center;"></div>');
    const $dirCard = $('<div style="background:#1c1f2e;border:1px solid rgba(129,140,248,.35);border-radius:16px;padding:18px 20px;width:min(560px,92vw);max-height:70vh;overflow:auto;color:#e8e8f2;"></div>');
    const $dirTitle = $('<div style="font-size:20px;font-weight:700;margin-bottom:10px;color:#a5b4fc;">📁 模型/LoRA 放在哪？</div>');
    const $dirList = $('<div style="margin:8px 0 12px;max-height:280px;overflow:auto;"></div>');
    const $dirInput = $('<input class="text_pole" style="width:calc(100% - 8px);font-size:16px;padding:8px;border-radius:8px;margin-bottom:10px;" placeholder="这里填你模型/LoRA 下载的位置（如 F:/ComfyUI/ComfyUI/models）">');
    const $dirBtns = $('<div style="display:flex;gap:10px;"></div>');
    const $dirOk = $('<button class="menu_button" style="min-width:110px;font-size:16px;white-space:nowrap;">✅ 确定</button>');
    const $dirCancel = $('<button class="menu_button" style="min-width:80px;font-size:16px;white-space:nowrap;">取消</button>');
    $dirBtns.append($dirOk, $dirCancel);
    $dirCard.append($dirTitle, $dirList, $dirInput, $dirBtns);
    $dirOv.append($dirCard);
    $panel.append($dirOv);
    let dirPickTarget = null;   // 'model' | 'lora'
    function openDirPicker(kind) {
        dirPickTarget = kind;
        const isModel = kind === 'model';
        const what = isModel ? '模型' : 'LoRA';
        $dirTitle.text('📁 ' + what + ' 放在哪？');
        const hint = `⬇ 下面填你${what}下载的位置（⬆ 上面是 ComfyUI 的默认位置）`;
        $dirList.empty();
        $dirInput.val(isModel ? taModelRoot : taLoraRoot);
        $dirList.append('<div class="muted" style="margin-bottom:8px;">正在枚举目录…</div>');
        fetch(`${BRIDGE}/list-models?kind=${kind}`).then(r => r.json()).then(d => {
            $dirList.empty();
            const dirs = [...new Set((d.items || []).map(x => x.dir).filter(Boolean))];
            if (!dirs.length) $dirList.append('<div class="muted">未枚举到目录（可用下面手动输入）</div>');
            const pushDir = (dir, badge) => {
                const $row = $('<div style="display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.04);margin-bottom:6px;cursor:pointer;font-size:16px;border:1px solid transparent;"></div>');
                $row.on('mouseenter', () => $row.css('background', 'rgba(129,140,248,.15)'));
                $row.on('mouseleave', () => $row.css('background', 'rgba(255,255,255,.04)'));
                $row.on('click', () => { $dirInput.val(dir); });
                $row.html(`<span style="word-break:break-all;flex:1;">📂 ${dir}</span>${badge ? '<span style="color:#8bc34a;white-space:nowrap;font-size:14px;">' + badge + '</span>' : ''}`);
                $dirList.append($row);
            };
            dirs.forEach(dir => pushDir(dir, ''));
            // 提示放中间：列表之后、输入框之前（⬆ 上=默认列表；⬇ 下=你填的位置）
            $dirList.append('<div class="muted" style="margin:6px 0 4px;font-size:15px;">' + hint + '</div>');
        }).catch(() => {
            $dirList.empty().append('<div class="muted">枚举失败（桥未启动？）可用下面手动输入</div><div class="muted" style="margin:6px 0 4px;font-size:15px;">' + hint + '</div>');
        });
        $dirOv.css('display', 'flex');
    }
    $dirOv.on('click', function (e) { if (e.target === this) $dirOv.css('display', 'none'); });
    $dirCancel.on('click', () => $dirOv.css('display', 'none'));
    $dirOk.on('click', () => {
        const v = $dirInput.val().trim();
        if (!v) { toastr.error('请输入或选择目录', '自动文生图'); return; }
        if (dirPickTarget === 'model') taModelRoot = v; else taLoraRoot = v;
        syncPathButtons();
        $dirOv.css('display', 'none');
        toastr.success('目录已填入（💾 保存后生效）', '自动文生图');
    });
    $btnRootPick.on('click', () => openDirPicker('model'));
    $btnLoraPick.on('click', () => openDirPicker('lora'));
    // ①+② 三行式：Line1 模型根目录📂 / Line2 LoRA目录📂 / Line3 💾保存+🔄刷新+统计（每行 one-line，不挤不换）
    const $inRootWrap = $('<div style="display:flex;align-items:center;flex-wrap:nowrap;width:100%;margin-top:4px;"></div>');
    const $inLoraWrap = $('<div style="display:flex;align-items:center;flex-wrap:nowrap;width:100%;margin-top:4px;"></div>');
    const $btnsWrap = $('<div style="display:flex;align-items:center;flex-wrap:nowrap;width:100%;margin-top:4px;"></div>');
    // 📥 选文件写入（桥 /upload-model）：浏览器选模型/LoRA 文件 → 流式写入所选目录
    const $btnUpload = $('<button id="tavern-img-upload-model" class="menu_button" style="min-width:118px;font-size:15px;white-space:nowrap;" title="选择本地的模型/LoRA 文件，自动写入目录（桥按文件名判断类型：unet→diffusion_models、vae→vae、lora→loras…）">📥 选文件写入</button>');
    const $fileIn = $('<input type="file" id="tavern-img-file" accept=".safetensors,.ckpt,.pt,.pth,.gguf" style="display:none">');
    $fileIn.on('change', async function () {
        const f = this.files && this.files[0];
        this.value = '';
        if (!f) return;
        const kind = /lora|lycoris/i.test(f.name) ? 'lora' : 'model';
        toastr.info('开始上传：' + f.name + '（' + Math.round(f.size / 1048576) + 'MB）…', '自动文生图');
        try {
            const resp = await fetch(`${BRIDGE}/upload-model?name=${encodeURIComponent(f.name)}&kind=${kind}`, { method: 'POST', body: f });
            const d = await resp.json();
            if (d.ok) { toastr.success('✅ 已写入：' + d.file + '（刷新模型/LoRA 列表即可看到）', '自动文生图'); }
            else { toastr.error('写入失败：' + (d.error || '未知错误'), '自动文生图'); }
        } catch (e) {
            toastr.error('上传失败：' + (e?.message || e), '自动文生图');
        }
    });
    $btnUpload.on('click', () => $fileIn.trigger('click'));
    $inRootWrap.append($btnRootPick, $btnLoraPick);
    $inLoraWrap.remove();
    $btnsWrap.append($btnPaths, $btnRefresh, $btnUpload, $fileIn);
    // 💾 保存：POST /paths（桥记录所选目录 → 枚举/上传以此为根）
    $btnPaths.on('click', async function () {
        try {
            const resp = await fetch(BRIDGE + '/paths', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_root: taModelRoot, lora_dir: taLoraRoot }),
            });
            const d = await resp.json();
            if (d.ok) { toastr.success('目录已保存（枚举/上传以此为根；ComfyUI 需重启才加载新目录）', '自动文生图'); }
            else { toastr.error('保存失败：' + (d.error || ''), '自动文生图'); }
        } catch (e) { toastr.error('保存失败：' + (e?.message || e), '自动文生图'); }
    });
    // 🔄 刷新：同时刷 /list-models（按用户目录枚举）与 /model
    $btnRefresh.on('click', async function () {
        try {
            const [mr, lr] = await Promise.all([
                fetch(`${BRIDGE}/list-models?kind=model`).then(r => r.json()).catch(() => null),
                fetch(`${BRIDGE}/list-models?kind=lora`).then(r => r.json()).catch(() => null),
            ]);
            const nModel = mr && mr.ok ? (mr.items || []).length : 0;
            const nLora = lr && lr.ok ? (lr.items || []).length : 0;
            $pathsHint.text(`枚举：模型 ${nModel} · LoRA ${nLora}`).css('color', '#8bc34a');
            // 同时刷新动态模型列表（/model 自动发现，与目录枚举一致）
            try {
                const mresp = await fetch(BRIDGE + '/model?refresh=1');
                const mdata = await mresp.json();
                if (Array.isArray(mdata.auto_models) && mdata.auto_models.length) {
                    currentAutoModels = mdata.auto_models;
                    $autoSel.empty().append('<option value="">未选择</option>');
                    mdata.auto_models.forEach(m => { $autoSel.append(`<option value="${m.file}">${m.label || m.file}</option>`); });
                    $rowAuto.show();
                }
            } catch (e) { /* 忽略 */ }
            toastr.success(`已按目录枚举：模型 ${nModel} 个 · LoRA ${nLora} 个`, '自动文生图');
        } catch (e) { toastr.error('枚举失败：' + (e?.message || e), '自动文生图'); }
    });

    $rowPaths.append($inRootWrap, $inLoraWrap, $btnsWrap, $pathsHint, $pathsCloudHint);
    $rowPaths.find('input,button').css('margin-right', '6px');
    $panel.append($rowPaths);

    // （模型自动发现刷新已并入上方 🔄 刷新 handler）

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

    // 推荐文案函数：按当前模型（家族）刷新"推荐 步数×分辨率"
    function updateRecHint() {
        const f = (modelSel?.val() || autoModelSel?.val() || '') || '';
        const fam = f ? stDetectFamily(f) : 'anima';
        const rec = ST_RECIPES[fam] || ST_RECIPES['anima'];
        const $h = $('[name="ta-img-rec-hint"]');
        if ($h.length) {
            const modelTxt = f ? (f.split(/[\\\\/]/).pop().slice(0, 26)) : '未选模型';
            $h.text(`推荐 ${rec.steps} 步 · ${rec.width}×${rec.height}（${modelTxt}）`);
        }
        return fam;
    }

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
        const stepsV = parseInt(document.getElementById('tavern-img-steps')?.value || '', 10);
        const wV = parseInt(document.getElementById('tavern-img-width')?.value || '', 10);
        const hV = parseInt(document.getElementById('tavern-img-height')?.value || '', 10);
        const body = {
            key: $select.val(),
            loras: loras,
            steps_num: Number.isFinite(stepsV) ? stepsV : null,
            w_num: Number.isFinite(wV) ? wV : null,
            h_num: Number.isFinite(hV) ? hV : null,
        };
        if (!connected) {
            // 无桥模式：速度档位存本地（模型/LoRA 由各自面板项保存）
            taSetLocalCfg({ steps_num: body.steps_num, w_num: body.w_num, h_num: body.h_num });
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
            // 桥模式速度档位回填：无新字段（steps_num/w_num/h_num）时留空=自动推荐

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
                        if (lc.steps_num != null) $('#tavern-img-steps').val(lc.steps_num);
                        if (lc.w_num != null) $('#tavern-img-width').val(lc.w_num);
                        if (lc.h_num != null) $('#tavern-img-height').val(lc.h_num);
                    } catch (e) { /* 忽略 */ }
                    $select.empty().append('<option value="">无桥模式（模型在右侧动态列表）</option>');
                } else {
                    // ST 代理 500/不可用 → 前端直连 ComfyUI /object_info（CORS 已开；无桥真·直连）
                    try {
                        const oiResp = await fetch(comfyUrl.replace(/\/+$/, '') + '/object_info', { signal: AbortSignal.timeout(15000) });
                        if (oiResp.ok) {
                            const oi = await oiResp.json();
                            const ckpts = oi?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
                            const unets = oi?.UNETLoader?.input?.required?.unet_name?.[0] || [];
                            const ggufs = oi?.UnetLoaderGGUF?.input?.required?.unet_name?.[0] || [];
                            const raw = [...ckpts.map(x => ({ value: x, text: x })), ...unets.map(x => ({ value: x, text: 'UNet: ' + x })), ...ggufs.map(x => ({ value: x, text: 'GGUF: ' + x }))];
                            const recs = raw.map(m => ({ file: m.value, family: stDetectFamily(m.value), label: (m.text || m.value).replace(/\.[^.]*$/, '').replace(/_/g, ' ') }));
                            currentAutoModels = recs;
                            $rowAuto.show();
                            $autoSel.empty().append('<option value="">未选择</option>');
                            recs.forEach(m => { $autoSel.append(`<option value="${m.file}">${m.label || m.file}</option>`); });
                            const saved = JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}').auto_model || '';
                            if (saved && recs.some(m => m.file === saved)) $autoSel.val(saved);
                            else { const fast = recs.find(m => m.family === 'sdxl') || recs[0]; if (fast) $autoSel.val(fast.file); }
                            const cur = $autoSel.val();
                            if (cur) {
                                const rec = recs.find(m => m.file === cur);
                                $autoHint.text(rec ? `家族：${rec.family || '-'}` : '');
                                localStorage.setItem('taImgLocalCfg', JSON.stringify({ ...(JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}')), auto_model: cur }));
                            }
                            try { const lc = JSON.parse(localStorage.getItem('taImgLocalCfg') || '{}'); if (lc.steps_num != null) $('#tavern-img-steps').val(lc.steps_num); if (lc.w_num != null) $('#tavern-img-width').val(lc.w_num); if (lc.h_num != null) $('#tavern-img-height').val(lc.h_num); } catch (e) { /* 忽略 */ }
                            $select.empty().append('<option value="">无桥模式（模型在右侧动态列表）</option>');
                        } else { $select.empty().append('<option value="">桥接服务未连接</option>'); }
                    } catch (e2) { $select.empty().append('<option value="">桥接服务未连接</option>'); }
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
        updateRecHint();   // ⭐ 无桥换模型 → 刷新推荐（步数/分辨率随家族变化）
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
        if (!key || key === currentKey) { saveSettings(); updateRecHint(); return; }
        currentKey = key;
        // 换模型 → 默认勾选该模型 default_loras，再保存
        fetch(BRIDGE + '/model').then(r => r.json()).then(data => {
            const defaults = (data.options[key] && data.options[key].default_loras) || [];
            currentOptions = data.options;  // 快照刷新，供 LoRA 家族适配重渲染
            renderLoras(data.options, key, defaults);
            saveSettings();
        }).catch(() => {});
        updateRecHint();   // ⭐ 换模型 → 刷新推荐（步数/分辨率随家族变化）
    });

            $loraBox.on('change', 'input[type=checkbox]', function () { saveSettings(); updateLoraBadge(); });
    $('#tavern-img-steps, #tavern-img-width, #tavern-img-height').on('change', saveSettings);

    // 提升为模块级引用（v3 事件触发用）
    modelSel = $select; loraBox = $loraBox; sizeSel = $sizeSel; stepsSel = $stepsSel; autoModelSel = $autoSel;
    setTimeout(updateRecHint, 500);   // ⭐ 初始化推荐文案（等模型列表回填后刷新）

    // ── 通道状态切换（无桥模式灰化依赖桥的能力 + 中文说明；桥模式恢复原样）──
    applyChannelUI = function (ch) {
        const noBridge = (ch === 'st' || ch === 'none');
        // ① 模型/LoRA 目录：只有桥能写盘；无桥 → 整行隐藏（傻瓜化：不显示用不了的东西）
        if (noBridge) {
            $rowPaths.hide();
        } else {
            $rowPaths.show();
        }
        $inRoot.prop('disabled', noBridge);
        $inLora.prop('disabled', noBridge);
        $btnPaths.prop('disabled', noBridge);
        $btnRefresh.prop('disabled', noBridge);
        $rowPaths.find('#tavern-img-browse-model, #tavern-img-browse-lora').prop('disabled', noBridge);
        $pathsCloudHint.text(noBridge ? '（模型/LoRA 下载到哪，就把存放位置选到哪；上方列表是 ComfyUI 默认位置）' : '（云部署的 ComfyUI 无需配置目录：模型清单由云端服务器自动提供）');
        // ③ API Key：无桥可填（存酒馆密钥库后隐藏）；不填则用酒馆主 API 密钥
        $inLlmKey.prop('disabled', false)
            .attr('title', '选填：填入后自动存入酒馆密钥库（隐藏存储），提示词请求即用此 key；不填则沿用酒馆主 API 的密钥')
            .attr('placeholder', noBridge ? 'API Key（选填）' : 'API Key（存桥本机，不回显）');
        // ③ 获取模型列表：桥/无桥都可用（无桥走酒馆服务端代理，读密钥库里的 key）
        $btnLlmModels.prop('disabled', false)
            .attr('title', '从该 API 获取模型列表（无桥模式：走酒馆代理，读你已存的 key）');
        // ⑧ 自定义工作流按钮区域不需要灰化（无桥也支持，见本地存储）
        // 辅助行瘦身：无桥 → 只留 📋出图日志（隐藏 扩展目录/卸载桥/桥安装指南）
        if (noBridge) {
            $rowAux.find('#ta-img-open-dir2, #ta-img-uninstall2, #ta-img-guide2').hide();
            $rowAux.find('#ta-img-log2').show();
        } else {
            $rowAux.find('#ta-img-open-dir2, #ta-img-uninstall2, #ta-img-guide2').show();
        }
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
    $rowAux.append('<span id="ta-img-log2" title="查看最近出图运行日志（含提示词/模型/耗时/错误）" style="cursor:pointer;font-size:15px;color:#34d399;padding:5px 12px;border-radius:8px;border:1px solid rgba(52,211,153,.4);white-space:nowrap;flex-shrink:0;">📋 出图日志</span>');
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
    // 出图日志卡（点 📋 展开最近 10 条：时间/通道/模型/家族/提示词/耗时/错误）
    const $logBox = $('<div id="ta-img-log-box" style="display:none;margin:8px 14px 0;padding:12px 14px;border-radius:12px;background:rgba(52,211,153,.06);border:1px solid rgba(52,211,153,.25);font-size:14px;line-height:1.7;color:#d1fae5;max-height:340px;overflow:auto;"></div>');
    function renderLogBox() {
        const logs = taGetRunLogs();
        if (!logs.length) { $logBox.html('<div style="color:rgba(230,230,242,.6);">暂无出图记录（发消息触发一次后这里会有日志）</div>'); return; }
        $logBox.html(logs.slice(0, 10).map((l, i) => {
            const p = l.positive || '';
            return '<div style="margin-bottom:12px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.25);">' +
                `<div style="color:#34d399;">#${logs.length - i}　${l.ts || ''}　${l.channel || ''}　${l.status || ''}${l.secs != null ? '（' + l.secs + 's）' : ''}</div>` +
                `<div style="color:#9aa;">模型：${l.model || '未选(自动兜底)'}　家族：${l.family || '-'}</div>` +
                (l.llm ? `<div style="color:#fbbf24;">LLM：${l.llm}</div>` : '') +
                (p ? `<div style="margin-top:4px;color:#e8e8f2;word-break:break-all;"><b>正向提示词：</b>${p}</div>` : '') +
                (l.negative ? `<div style="color:rgba(230,230,242,.55);word-break:break-all;"><b>负向：</b>${l.negative.slice(0, 180)}${l.negative.length > 180 ? '…' : ''}</div>` : '') +
                (l.error ? `<div style="color:#f87171;word-break:break-all;"><b>错误：</b>${l.error}</div>` : '') +
                '</div>';
        }).join(''));
    }
    $rowAux.on('click', '#ta-img-log2', function () {
        renderLogBox();
        $logBox.toggle();
    });
    $panel.append($logBox);

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
        '④ 失败看红色提示，或点「停止任务」中断；' +
        '⑤ 模型/LoRA 放哪：ComfyUI 的 <b>models/checkpoints</b>（底模）、<b>models/diffusion_models</b>（Unet）、<b>models/loras</b>（LoRA）——下载好的文件丢进对应文件夹，刷新即可见。' +
        '<span style="color:rgba(230,230,242,.45);">（无桥模式：零安装，直连 ComfyUI 出图；模型/LoRA 由 ComfyUI 自动枚举）</span>'
    );

    // 按用户指定顺序重排（DOM 移动，不影响引用）：
    // 状态行置顶 → 总开关 → 简要指南 → 模型/LoRA目录 → 服务配置和API → 模型选择 → LoRA选择 → 速度档位；提示词规则置底；辅助行+指南卡
    [$rowMode, $stopRow, $rowHelp, $rowPaths, $rowCfg, $rowLLM, $rowAuto, $rowLora, $rowSpeed, $rowPrompt, $rowWf, $rowModel, $rowAux, $guideBox, $logBox]
        .forEach(x => { if (x) $panel.append(x); });

    loadModelOptions();
    loadConfig();
    checkComfyStatus();
    $host.append($panel);
    return $panel;
}

// ── SSE 连接 ────────────────────────────────────────────────
// 桥任务挂起管理器（双保险串行：桥 job 异步结果经由 SSE 带 job id 回传）
const taPendingJobs = new Map();   // jobId -> {resolve, reject, timer}
function waitBridgeJob(jobId, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
            taPendingJobs.delete(jobId);
            // SSE 兜底：超时后一次性查 /jobs（不轮询）
            try {
                const r = await fetch(BRIDGE + '/jobs');
                const d = await r.json();
                const j = (d.jobs || []).find(x => x.id === jobId);
                if (j && j.result && j.result.ok && j.result.url) resolve({ url: j.result.url, model: j.result.model || '' });
                else reject(new Error('超时/未完成：' + (j?.result?.error || '无结果')));
            } catch (e) { reject(new Error('任务超时（桥无响应）')); }
        }, timeoutMs);
        taPendingJobs.set(jobId, { resolve: (v) => { clearTimeout(timer); taPendingJobs.delete(jobId); resolve(v); }, reject: (e) => { clearTimeout(timer); taPendingJobs.delete(jobId); reject(e); }, timer });
    });
}

// 桥模式触发（202）：双保险串行——桥 engineer → 失败回退前端 stEngineer → 带 prompt 重提
async function generateViaBridge(text, name, lock) {
    const mkBody = (extra) => ({ text: text, name: name, ...extra });
    const r0 = await fetch(BRIDGE + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mkBody({})) });
    const d0 = await r0.json();
    if (!d0.ok) throw new Error(d0.error || '桥触发失败');
    try {
        const img = await waitBridgeJob(d0.job, 240000);
        showImage(img, lock);
        return;
    } catch (e) {
        // 双保险：桥失败（提示词/生成任一步）→ 前端 stEngineer → 带 prompt 重新提交（串行）
        console.warn('[ta-img][diag] 桥链路失败，回退前端提示词：', e.message);
        try {
            const fam = getCurrentFamilySafe();
            const pr = await stEngineer(text, fam);
            const r1 = await fetch(BRIDGE + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mkBody({ prompt: { positive: pr.positive, male: pr.male } })) });
            const d1 = await r1.json();
            if (!d1.ok) throw new Error('回退提交失败：' + d1.error);
            const img2 = await waitBridgeJob(d1.job, 240000);
            showImage(img2, lock);
        } catch (e2) {
            throw new Error('双保险回退失败：' + (e2?.message || e2));
        }
    }
}
function getCurrentFamilySafe() {
    try { return (window.__taCurFamily || ''); } catch (e) { return ''; }
}

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
            // 带 job id 的失败 → 交给挂起管理器（双保险回退）；无 job → 全局红条（旧行为）
            if (data.job && taPendingJobs.has(data.job)) {
                try { taPendingJobs.get(data.job).reject(new Error(data.message || '桥任务失败')); } catch (e) { /* 忽略 */ }
                return;
            }
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
            // 带 job id 的完成 → 交给挂起管理器（带楼层锁挂图）；无 job → 旧兼容路径
            if (data.job && taPendingJobs.has(data.job)) {
                try { taPendingJobs.get(data.job).resolve(data); } catch (e) { /* 忽略 */ }
                return;
            }
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
let taAllowTrigger = false;      // 用户消息门闩：只有用户发过消息后才允许出图（切卡=锁，防历史加载自动出图）
let taResendArmed = false;       // 重发信号（#option_regenerate 点击后 60s 内=重发窗口）
let taResendTimer = null;        // 重发窗口超时计时器
let taLastJob = null;            // 最近一次出图任务（文本/角色名/楼层锁）——占位符「重新生成提示词」按钮用
let taGenEpoch = 0;              // 任务纪元号：每次新任务/中断 +1；旧任务每步自查（过期=抛 AbortError 自杀）→ 手动重跑/自动重试/重发互不打架
let taChatChangedAt = Date.now(); // 最近一次切卡/加载时间（5 秒窗口内渲染的用户消息=历史加载，不解锁）
let taLastUserSentDate = '';      // 最近一条用户消息 send_date（回复须晚于它；历史/开场白早于它→拦）

// 是否开场白/首条角色消息（ST 开场白 = chat 第一条角色消息；用户明确：开场白不出图）
function isFirstMessage(msg) {
    try {
        const c = getCtx();
        if (!c || !c.chat || !c.chat.length) return false;
        if (msg && c.chat[0] === msg && !msg.is_user) return true;        // 第一条角色消息=开场白（无论 chat 多长）
        if (c.chat.length === 1 && msg && !msg.is_user) return true;
        if (msg && msg.extra && msg.extra.type === 'first_message') return true;
        return false;
    } catch (e) { return false; }
}

function getCtx() {
    try { return window.SillyTavern.getContext(); } catch (e) { return null; }
}

async function triggerOnce(msg, overrideText, lockIn) {
    const ctx = getCtx();
    // 从 chat 里取当前消息（ST 消息无 id → 用对象引用/send_date 判定最近一条）
    const last = ctx && ctx.chat && ctx.chat.length ? ctx.chat[ctx.chat.length - 1] : null;
    const isRecent = !!(last && (last === msg || (last.send_date && msg.send_date && last.send_date === msg.send_date) || overrideText));
    // 只处理角色回复：非用户、非系统（我们自己的"已生成图片"就是系统消息）
    if (!isRecent) return;
    if (msg.is_user || msg.is_system) return;
    // 开场白（first_message）不出图：用户明确视为 bug
    if (isFirstMessage(msg)) {
        console.log('[tavern-auto-img] 开场白/首条角色消息，跳过出图');
        return;
    }
    // 用户消息门闩：未发过消息（切卡历史加载/直接看卡）→ 一律不出图
    if (!taAllowTrigger) {
        console.log('[tavern-auto-img] 尚未发送用户消息（门闩锁），跳过');
        return;
    }
    // 生成未完成防"半截"：回复应晚于最近用户消息（历史/开场白早于用户消息 → 拦）；文本稳定由防抖保证
    if (taLastUserSentDate && msg.send_date && String(msg.send_date) < String(taLastUserSentDate)) {
        console.log('[tavern-auto-img] 早于最近用户消息（历史/开场白），跳过');
        return;
    }
    const seenKey = String(msg.send_date || msg.id || '') + '|' + String((msg.mes || '').length);
    if (seenMessages.has(seenKey)) return;
    seenMessages.add(seenKey);
    pendingImgTarget = msg;   // 兼容保留（新版主要用 lock）
    if (seenMessages.size > 100) {
        const first = seenMessages.values().next().value;
        seenMessages.delete(first);
    }
    const text = String(overrideText || msg.mes || msg.message || '').trim();
    if (!text) return;
    // 任务锁：图片/占位符与本次回复绑定定死（第二条消息触发时不覆盖第一条；且不删第一条的占位符）
    const lock = Object.assign({}, lockIn || {}, { msg: msg, sendDate: String(msg.send_date || ''), head: String(text).slice(0, 40) });
    taLastJob = { text: text, name: (msg.name || msg.ch_name || '').trim() || '角色', lock: lock };   // ⭐ 供占位符「重新生成提示词」按钮重跑
    console.log('[tavern-auto-img] 收到角色回复, 触发自动文生图, id=', msg.id, 'send_date=', msg.send_date);
    // 通道选择：桥活着 → 桥；桥没起 → ST 原生代理（无桥模式）；都没有 → 提示装桥
    const channel = await detectChannel();
    if (channel !== 'none') addImgPlaceholder(lock.el, msg.name);   // 触发即占位（绑在该楼层，消息快也不消失）
    if (channel === 'st') {
        // 无桥模式总开关（本地存储）：关闭时跳过并提示
        if ((taGetLocalCfg().enabled ?? true) === false) {
            toastr.warning('自动文生图总开关已关闭（⚡ 控制台顶栏开关），本次跳过出图', '自动文生图');
            return;
        }
        try {
            // 任务锁已在上方构建（含楼层锚 el）
            await generateViaST(text, msg.name || '角色', lock);
        } catch (e) {
            // 被中断（重roll/编辑/急停/被接管）→ 静默，不弹红框
            if (e && (e.name === 'AbortError' || /abort|已被接管/i.test(String(e.message || '')))) {
                removeImgPlaceholder(lock.el);
                taLogRun({ status: '⏹ 已中断', error: '用户重roll/编辑/急停' }, true);
                console.info('[tavern-auto-img] 任务已中断（用户重roll/编辑/接管）');
                return;
            }
            console.error('[tavern-auto-img] 无桥模式失败:', e);
            taLogRun({ status: '❌ 失败', secs: 0, error: (e?.message || '未知错误') }, true);
            const stack = (e && e.stack ? e.stack.split('\n').slice(0, 4).map(s => s.trim()).join(' ← ') : (e?.message || '未知错误'));
            showError({ message: (e?.message || '无桥模式出图失败') + ' | ' + stack });
        }
        return;
    }
    if (channel === 'none') {
        showError({ message: '桥未启动，且 ComfyUI 代理不可用。请在控制台按提示装桥（install.bat）或检查 ComfyUI 地址' });
        return;
    }
    // ── 桥模式：双保险串行（桥 engineer → 失败回退前端 stEngineer → 带 prompt 重提）──
    try {
        await generateViaBridge(text, msg.name || '角色', lock);
    } catch (e) {
        if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) {
            removeImgPlaceholder(lock.el);
            taLogRun({ status: '⏹ 已中断', error: '用户重roll/编辑/急停' }, true);
            console.info('[tavern-auto-img] 任务已中断（用户重roll/编辑）');
            return;
        }
        console.error('[tavern-auto-img] 桥模式失败:', e);
        taLogRun({ status: '❌ 失败', secs: 0, error: (e?.message || '未知错误') }, true);
        showError({ message: (e?.message || '桥模式出图失败') + ' | 两路提示词均已尝试' });
    }
}

// 监听发送按钮状态（用户方案：单点状态机）
// ① 纸飞机点击/Enter = 用户发送 → 门闩解锁
// ② 圆圈(#mes_stop)点击 = 用户急停 → 中断图任务
// ③ 圆圈→纸飞机（生成完成） = 出图触发信号（唯一触发点）
function taBindSendMonitor() {
    if (window.__taSendBound) return;
    const $sb = $('#send_but');
    if (!$sb || !$sb.length) { setTimeout(taBindSendMonitor, 800); return; }
    const $ms = $('#mes_stop');
    const unlock = function () {
        setTimeout(() => {
            try {
                if (!taAllowTrigger) {
                    taAllowTrigger = true;
                    const c0 = getCtx();
                    if (c0 && c0.chat) {
                        const usr = [...c0.chat].reverse().find(m => m && m.is_user);
                        if (usr) taLastUserSentDate = usr.send_date || '';
                    }
                    console.log('[ta-img][diag] 发送按钮/Enter 检测 → 门闩解锁');
                }
            } catch (e) { /* 忽略 */ }
        }, 150);
    };
    $sb.on('click', unlock);
    const $ta = $('#send_textarea');
    if ($ta.length) $ta.on('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) unlock(); });
    // ⭐ 信号2：☰ 菜单「重新生成」（#option_regenerate 点击）= 重发信号（用户：两个信号同时监控，哪个干活用哪个）
    $(document).on('click', '#option_regenerate', function () {
        taResendArmed = true;
        taAllowTrigger = true;
        seenMessages.clear();
        taInterruptImageTask();      // ⭐ 重发=删本条+再生：旧任务必须先断（ST 不发 message_swiped，只能这里补）
        removeImgPlaceholder();      // ⭐ 旧占位符一并清除
        if (taResendTimer) clearTimeout(taResendTimer);
        taResendTimer = setTimeout(() => { taResendArmed = false; }, 60000);
        console.log('[ta-img][diag] 重新生成按钮点击 → 中断旧任务+删占位+解锁+清seen（重发信号）· 60s 内重发兜底可触发');
    });
    // ⭐ 信号2b：用户消息右侧「重新发送」↻（类名不固定→泛化委托：用户消息按钮里图标含 fa-rotate/fa-sync/fa-arrows-rotate 的点击）
    if (!window.__taUserResendBound) {
        window.__taUserResendBound = true;
        $(document).on('click', '.mes[is_user="true"] .mes_button', function () {
            const cls = (this.className || '') + ' ' + (this.title || '');
            if (!/rotat|sync|reply|send|again|resend|redo/i.test(cls)) return;
            taResendArmed = true;
            taAllowTrigger = true;
            seenMessages.clear();
            taInterruptImageTask();
            removeImgPlaceholder();
            if (taResendTimer) clearTimeout(taResendTimer);
            taResendTimer = setTimeout(() => { taResendArmed = false; }, 60000);
            console.log('[ta-img][diag] 用户消息重发↻点击 → 中断旧任务+删占位+解锁+清seen（重发信号）· 60s 兜底');
        });
    }
    // 用户点"圆圈"（急停）→ 中断图任务（ST 自己停止生成；我们同步停图）
    if ($ms && $ms.length) {
        $ms.on('click', function () {
            console.log('[ta-img][diag] 急停按钮被点击 → 中断图任务');
            taInterruptImageTask();
            removeImgPlaceholder();
        });
    }
    // 完成检测：生成中 #mes_stop（圆圈）display:flex；完成后 display:none（圆消失=回到纸飞机态）→ 唯一出图触发点
    const isStopVisible = function () { return $ms.length && $ms.css('display') !== 'none'; };
    const taFireTrigger = function (src) {
        try {
            const c = getCtx();
            // 直接从网页抓最新角色回复文本（DOM=用户所见；不赌 chat 数组时序）
            const $mes = $('.mes[is_user="false"]').last();
            const domText = $mes.length ? ($mes.find('.mes_text').text() || '').trim() : '';
            const domName = $mes.length ? ($mes.attr('ch_name') || '') : '';
            console.log('[ta-img][diag] ' + (src || '触发') + '：', (domName || '?'), '| 网页文本头=', String(domText).slice(0, 60).replace(/\n/g, ' '), '| domLen=', domText.length);
            const last = c && c.chat ? c.chat[c.chat.length - 1] : null;
            // 楼层锚：抓住这一层 .mes 元素本身（出图后原地放图，与楼层绑定定死）
            const elLock = $mes.length ? $mes[0] : null;
            console.log('[ta-img][diag] 楼层锚=', elLock ? ('#mes 元素已捕获 isConnected=' + elLock.isConnected) : 'null');
            if (last && !last.is_user && !last.is_system) triggerOnce(last, domText, { el: elLock });
            else if (domText && domName) triggerOnce({ name: domName, mes: domText, is_user: false }, domText, { el: elLock });
        } catch (e) { /* 忽略 */ }
    };
    const mo = new MutationObserver(function () {
        const nowV = isStopVisible();
        if (prevStopVisible && !nowV) {
            console.log('[ta-img][diag] 圆圈消失（生成完成）→ 300ms 后抓网页文本出图');
            try {
                if (autoGenTimer) clearTimeout(autoGenTimer);
                autoGenTimer = setTimeout(function () { taFireTrigger('圆圈消失'); }, 300);
            } catch (e) { /* 忽略 */ }
        }
        prevStopVisible = nowV;
    });
    // ⭐ 重发兜底：重发信号后 60s 内，若重发完成（生成结束 message_updated）而圆圈信号缺席 → 兜底触发（哪个信号干活用哪个）
    if (!window.__taResendFallbackBound) {
        window.__taResendFallbackBound = true;
        const ctx0 = getCtx();
        if (ctx0 && ctx0.eventSource) {
            ctx0.eventSource.on('message_updated', function () {
                if (!taResendArmed || !taAllowTrigger) return;
                taResendArmed = false;
                console.log('[ta-img][diag] 重发兜底：message_updated（生成结束）→ 触发重发出图');
                setTimeout(function () { taFireTrigger('重发兜底'); }, 300);
            });
        }
    }
    let prevStopVisible = isStopVisible();
    if ($ms && $ms.length) mo.observe($ms[0], { attributes: true, attributeFilter: ['style', 'class'] });
    window.__taSendBound = true;
    console.log('[ta-img][diag] 生成状态监控已绑定（#mes_stop 圆圈显示/消失）');
}

function bindMessageEvents() {
    // 重试等待 ST 就绪（getContext 可能未就绪）；绑定后即插即用
    let tries = 0;
    const tryBind = function () {
        const ctx = getCtx();
        if (ctx && ctx.eventSource) {
            // 用户消息门闩解锁：已全部改由发送按钮监控（taBindSendMonitor）；
            // 仅保留切换/中断类监听（图任务状态管理）
            // 切换角色/聊天时：锁门闩+重置观察基线+防重记录（防历史加载/别的聊天误触发出图）
            ctx.eventSource.on('chat_id_changed', function () {
                taAllowTrigger = false;
                taChatChangedAt = Date.now();
                taLastUserSentDate = '';
                window.__taImgLastKey = '';
                seenMessages.clear();
                removeImgPlaceholder();
            });
            // 重 roll / 滑动 / 编辑消息 → 立即中断正在生成的图任务（含提示词 LLM）
            ctx.eventSource.on('message_swiped', function (msgId) {
                taInterruptImageTask();
                removeImgPlaceholder();
                taAllowTrigger = true;   // 重 roll 属于"已激活的会话"：保持解锁（已切卡则被 chat_id_changed 锁）
                seenMessages.clear();    // ⭐ 重发/重roll 同文本指纹与上次相同 → 清 seen 防被"已触发"拦住（门闩+send_date 防线仍有效）
                console.log('[ta-img][diag] message_swiped → 中断+解锁+清seen 重出图, id=', msgId);
            });
            ctx.eventSource.on('message_edited', function () {
                taInterruptImageTask();
                removeImgPlaceholder();
            });
            console.log('[ta-img][diag] 事件监听已切换（触发=发送按钮状态机）');
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
    setTimeout(taBindSendMonitor, 1500);  // 发送按钮监控（门闩解锁）
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
