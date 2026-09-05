// Tavern Auto Image — 酒馆服务端插件（Node 桥）
// 装进 SillyTavern/plugins/ 后：酒馆一启动 = 桥自动运行（端口 8645，前端扩展零改动）
// 依赖：仅 Node 内置模块（http/fs/path/crypto/child_process）。要求 Node 22+（全局 WebSocket/fetch）。
// 配置：酒馆根目录 data/default-user/tavern-auto-img/config.json（可选；全部有默认值）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const PORT = parseInt(process.env.TAIMG_PORT || '8645', 10);

// 数据目录：优先环境变量 → 酒馆 data/default-user/tavern-auto-img → cwd/data
const DATA_DIR = process.env.TAIMG_DATA_DIR
    || path.join(process.cwd(), 'data', process.env.TAIMG_USER || 'default-user', 'tavern-auto-img');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CFG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'model_choice.json');
const PROMPT_EDIT_FILE = path.join(DATA_DIR, 'prompt_edit.txt');
const WF_CUSTOM_FILE = path.join(DATA_DIR, 'wf_custom.json');
const LOG_FILE = path.join(DATA_DIR, 'bridge.log');
const CLOUD_CACHE = path.join(DATA_DIR, 'cloud_cache');
fs.mkdirSync(CLOUD_CACHE, { recursive: true });

// 日志 tee（console + 文件）
function log(...a) {
    const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* 忽略 */ }
}

// ── 配置（config.json / 环境变量 / 默认）──
let CFG = {
    comfy_root: '',
    comfy_extra_paths: '',
    tavern_img_dir: '',
    tavern_data_dir: '',
    port: PORT,
};
function loadCfg() {
    try {
        if (fs.existsSync(CFG_FILE)) {
            const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
            Object.assign(CFG, c);
        }
    } catch { /* 忽略 */ }
}
function saveCfgIfNoFile() {
    try {
        if (!fs.existsSync(CFG_FILE)) {
            fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2), 'utf8');
        }
    } catch { /* 忽略 */ }
}
loadCfg();
function comfyUrl() { return (ST.comfy_url || 'http://127.0.0.1:8188').trim().replace(/\/+$/, ''); }
function tavernImgDir() { return CFG.tavern_img_dir || path.join(process.cwd(), 'public', 'tavern-img'); }
function comfyOutputRoot() { return CFG.comfy_root ? path.join(CFG.comfy_root, 'output') : ''; }
function tavernDataDir() { return CFG.tavern_data_dir || path.join(process.cwd(), 'data', 'default-user'); }

// ── 状态 ──
const ST = {
    enabled: true,
    key: '',
    loras: [],
    size_mult: 1, steps_mult: 1,
    auto_model: '',
    family: '',
    comfy_url: 'http://127.0.0.1:8188',
    llm: { mode: 'custom', endpoint: '', key: '', model: '' },
};
const jobs = [];
const sseClients = new Set();
let lastGenFp = { fp: '', ts: 0 };
let cancelFlag = false;
let currentProc = null;

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            Object.assign(ST, d);
        }
    } catch { /* 忽略 */ }
    ST.enabled = ST.enabled !== false;
}
function saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(ST, null, 2), 'utf8'); } catch { /* 忽略 */ }
}
loadState();

// ── ComfyUI 客户端 ──
async function comfyGet(p) {
    const url = comfyUrl() + p;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`ComfyUI ${p} -> HTTP ${r.status}`);
    return r.json();
}
async function comfyPost(p, body, timeoutMs = 30000) {
    const url = comfyUrl() + p;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json();
    if (!r.ok) throw new Error(`ComfyUI ${p} -> ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
    return d;
}
async function comfyView(fname, subfolder, type) {
    const url = comfyUrl() + '/view?' + new URLSearchParams({ filename: fname, subfolder, type });
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const safe = fname.replace(/[^\w\.\-]+/g, '_').slice(-80) || 'img.png';
    const local = path.join(CLOUD_CACHE, safe);
    fs.writeFileSync(local, buf);
    return local;
}

// ── 家族识别 + 标准工作流构建（只用内置节点）──
const FAMILY_RULES = [
    [['anima', 'unholy', 'hassaku', 'nova', 'miaomiao', 'anima29', 'turbo'], 'anima'],
    [['krea2', 'gonzalomo', 'moody'], 'krea2'],
    [['flux', 'dev', 'z_image', 'zimage', 'zit'], 'flux'],
    [['kodoranime'], 'sdxl'],
];
const CP_HINTS = ['kodoranime', 'unrealvision', 'sdxl', 'pony', 'illustrious', 'anything'];
function detectFamily(file) {
    const n = (file || '').toLowerCase();
    for (const [kws, fam] of FAMILY_RULES) if (kws.some(k => n.includes(k))) return fam;
    if (CP_HINTS.some(k => n.includes(k))) return 'sdxl';
    return 'anima';
}
const RECIPES = {
    anima: { clip: ['miaomiaoHarem_anima16_txt.safetensors', 'qwen_image'], vae: 'qwen_image-vae.safetensors', latent: ['EmptySD3LatentImage', 16], sampler: 'euler', scheduler: 'simple', steps: 20, cfg: 4.0, width: 512, height: 768 },
    krea2: { clip: ['gonzalomoKrea2_v40_txt.safetensors', 'krea2'], vae: 'qwen_image-vae.safetensors', latent: ['EmptySD3LatentImage', 16], sampler: 'er_sde', scheduler: 'simple', steps: 8, cfg: 1.0, width: 832, height: 1216 },
    flux: { clip: ['t5xxl_fp8_e4m3fn.safetensors', 'flux'], vae: 'flux-vae-bf16.safetensors', latent: ['EmptySD3LatentImage', 16], sampler: 'euler', scheduler: 'simple', steps: 20, cfg: 1.0, width: 832, height: 1216, dual: true, clip2: 'clip_l.safetensors' },
    sdxl: { checkpoint: true, latent: ['EmptyLatentImage', 4], sampler: 'euler', scheduler: 'normal', steps: 20, cfg: 7.0, width: 512, height: 768 },
};
function buildWorkflow(modelFile, family, loras, sizeMult, stepsMult, prompt, negative) {
    const rec = RECIPES[family] || RECIPES['anima'];
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
    const pn = nxt(); clipText(pn, clipRef, prompt);
    const nn = nxt(); clipText(nn, clipRef, negative);
    const sn = nxt();
    wf[sn] = { class_type: 'KSampler', inputs: { model: modelRef, seed: crypto.randomInt(0, 2 ** 31 - 1), steps, cfg: rec.cfg, sampler_name: rec.sampler, scheduler: rec.scheduler, denoise: 1.0, negative: [nn, 0], positive: [pn, 0], latent_image: [ln, 0] } };
    const dn = nxt();
    wf[dn] = { class_type: 'VAEDecode', inputs: { samples: [sn, 0], vae: vaeRef } };
    const fnn = nxt();
    wf[fnn] = { class_type: 'SaveImage', inputs: { images: [dn, 0], filename_prefix: 'tavern_auto' } };
    // LoRA 链
    if (loras && loras.length) {
        let cm = modelRef, cc = clipRef;
        for (const [lf, sm, sc] of loras) {
            const ln2 = nxt();
            wf[ln2] = { class_type: 'LoraLoader', inputs: { lora_name: lf, strength_model: sm, strength_clip: sc, model: cm, clip: cc } };
            cm = [ln2, 0]; cc = [ln2, 1];
        }
        const sn2 = nxt();
        // 重定向采样器输入到 LoRA 链尾
        wf[sn2] = wf[sn];
        // 直接修改采样器引用
        wf[sn].inputs.model = cm;
        wf[sn].inputs.positive = [pn, 0];
        wf[sn].inputs.negative = [nn, 0];
        delete wf[sn2];
        nid = parseInt(sn);
    }
    return wf;
}

let listsCache = { ts: 0, clips: [], vaes: [] };
async function comfyLists(force) {
    if (!force && Date.now() - listsCache.ts < 120000 && listsCache.clips.length) return listsCache;
    const clips = [], vaes = [];
    try {
        const oi = await comfyGet('/object_info');
        clips.push(...(oi['CLIPLoader']?.input?.required?.clip_name?.[0] || []));
        vaes.push(...(oi['VAELoader']?.input?.required?.vae_name?.[0] || []));
    } catch (e) { log('[enum] CLIP/VAE 枚举失败', e.message); }
    listsCache = { ts: Date.now(), clips, vaes };
    return listsCache;
}

// ── 模型/LoRA 枚举（object_info）──
let autoModelsCache = { ts: 0, list: [] };
async function autoModels(force) {
    if (!force && Date.now() - autoModelsCache.ts < 60000 && autoModelsCache.list.length) return autoModelsCache.list;
    const list = [];
    try {
        const oi = await comfyGet('/object_info');
        for (const cls of ['CheckpointLoaderSimple', 'UNETLoader']) {
            const def = oi[cls];
            if (!def) continue;
            const items = def?.input?.required?.[cls === 'UNETLoader' ? 'unet_name' : 'ckpt_name']?.[0] || [];
            for (const f of items) {
                if (typeof f !== 'string' || f.includes('put_') || f.startsWith('.')) continue;
                list.push({ file: f, family: detectFamily(f), kind: cls === 'CheckpointLoaderSimple' ? 'ckpt' : 'unet', label: (f.includes('unholy') || f.includes('hassaku') || f.includes('nova') || f.includes('miaomiao')) ? '动漫-Anima — ' + f : f });
            }
        }
    } catch (e) { log('[enum] 模型枚举失败', e.message); }
    autoModelsCache = { ts: Date.now(), list };
    return list;
}
let lorasCache = { ts: 0, list: [] };
async function loras(force) {
    if (!force && Date.now() - lorasCache.ts < 60000 && lorasCache.list.length) return lorasCache.list;
    const list = [];
    try {
        const oi = await comfyGet('/object_info');
        const def = oi['LoraLoader'];
        const items = def?.input?.required?.lora_name?.[0] || [];
        for (const f of items) {
            if (typeof f !== 'string') continue;
            const fam = detectFamily(f);
            list.push({ file: f, family: fam, label: f, meta_err: '' });
        }
    } catch (e) { log('[enum] LoRA 枚举失败', e.message); }
    lorasCache = { ts: Date.now(), list };
    return list;
}

// ── LLM 工程器 ──
const ENGINEER_SYSTEM = `你是文生图提示词工程师。用户会给你一段酒馆角色的剧情回复文本，你输出可直接用于 ComfyUI 文生图的英文正向提示词。
规则：
1. 只依据给出的剧情文本构建，文本没写的一律不加（衣服/发色/场景/情绪按原文）。
2. 性别按原文判断：男性/少年 → male 相关词；女性/少女 → female/1girl；不明 → female。
3. 不要输出任何分析、解释、代码块，只输出 JSON。
4. 输出格式：{"positive":"英文提示词（逗号分隔，含风格、主体、细节、光线、环境）","male":false}
正面词示例风格：RAW photo, photorealistic, masterpiece, best quality, 1girl, ...，具体风格按模型族（{family}）微调：anima=2D 动漫（anime illustration）等；sdxl=写实/2.5D；flux=高质写实/艺术；krea2=厚涂写实。`;
async function engineer(text, family) {
    const llm = ST.llm;
    const system = (() => {
        try {
            if (fs.existsSync(PROMPT_EDIT_FILE)) {
                const o = fs.readFileSync(PROMPT_EDIT_FILE, 'utf8').trim();
                if (o) return o;
            }
        } catch { /* 忽略 */ }
        return ENGINEER_SYSTEM.replace('{family}', family);
    })();
    const user = `模型族：${family}\n剧情回复文本：\n${text.slice(0, 6000)}`;
    const endpoint = (llm.endpoint || '').replace(/\/+$/, '');
    const body = { model: llm.model || 'deepseek-chat', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.7, max_tokens: 900 };
    const r = await fetch(endpoint + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (llm.key || '') },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
    const d = await r.json();
    const content = d?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM 未返回 JSON');
    const parsed = JSON.parse(m[0]);
    return { positive: parsed.positive || '', male: !!parsed.male };
}

// ── 酒馆主 API 读取 ──
function readTavernApi() {
    const dir = tavernDataDir();
    try {
        const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
        const oai = settings.oai_settings || {};
        const source = oai.chat_completion_source || 'openai';
        const endpoint = oai.custom_url || oai.reverse_proxy || oai.openai_base_url || '';
        const model = oai[`${source}_model`] || oai.openai_model || '';
        let key = '';
        try {
            const sec = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
            let raw = sec[`api_key_${source}`];
            if (typeof raw === 'string') raw = JSON.parse(raw);
            if (Array.isArray(raw)) {
                const pick = raw.find(x => x && x.active === true) || raw.find(x => x && x.value) || null;
                key = pick?.value || '';
            }
        } catch { /* 忽略 */ }
        return { endpoint: endpoint || '', model: model || '', key };
    } catch (e) {
        return { endpoint: '', model: '', key: '', err: String(e) };
    }
}

// ── 发布 ──
function publish(pngPath, prompt, model, name) {
    if (!pngPath || !fs.existsSync(pngPath)) throw new Error('输出文件不存在: ' + pngPath);
    const dir = tavernImgDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(pngPath);
    const safe = base.replace(/[^\w\-]+/g, '_').slice(-60) || 'img.png';
    const fname = `${safe}_${Math.floor(Date.now() / 1000)}${path.extname(pngPath)}`;
    const dest = path.join(dir, fname);
    fs.copyFileSync(pngPath, dest);
    return `http://127.0.0.1:8000/tavern-img/${fname}`;
}

// ── 出图主流程 ──
async function runJob(job) {
    cancelFlag = false;
    job.status = 'running';
    try {
        const st = ST;
        if (!st.enabled) throw new Error('文生图已关闭');
        // 确定模型：面板选了就用它；没选 → 自动挑一个（优先 sdxl 稳定模型）
        let model_file = (st.auto_model || '').trim();
        if (!model_file) {
            const am = await autoModels(false);
            const pick = am.find(m => m.family === 'sdxl') || am[0];
            model_file = pick ? pick.file : '';
            if (model_file) { st.auto_model = model_file; st.family = detectFamily(model_file); saveState(); }
        }
        if (!model_file) throw new Error('未选择模型（请在面板④ 模型选择 里选一个）');
        // 动态判定：模型在 ComfyUI checkpoint 枚举里 → 用通用 checkpoint 模式（自带 CLIP/VAE，任何这类模型都稳）
        const amInfo = (await autoModels(false)).find(m => m.file === model_file);
        if (amInfo && amInfo.kind === 'ckpt') st.family = 'sdxl';
        const family = st.family || detectFamily(model_file);
        broadcast({ type: 'stage', stage: 'engineer', msg: '🤖 提示词生成中…' });
        const pr = await engineer(job.text, family);
        const negative = 'bad quality, worst quality, lowres, blurry, extra limbs, deformed hands, text, watermark'
            + (pr.male ? ', female, woman, girl, big breasts, cleavage, westerner, caucasian' : '');
        broadcast({ type: 'stage', stage: 'submit', msg: '✅ 提示词生成完成，开始生图任务…' });
        if (cancelFlag) throw new Error('任务已急停');
        // 自定义工作流 or 自动构建
        let wf;
        const wc = loadWfCustom();
        if (wc.enabled && Object.keys(wc.wf).length) {
            wf = applyWfCustom(wc.wf, pr.positive, pr.negative);
            log('[gen] 使用自定义工作流', Object.keys(wf).length, '节点');
        } else {
            const lorasList = (st.loras || []).map(f => [f, 0.8, 0.8]);
            const rec = RECIPES[family] || RECIPES['anima'];
            if (!rec.checkpoint) {
                const L = await comfyLists(false);
                const needClip = rec.dual ? [rec.clip2, rec.clip[0]] : [rec.clip[0]];
                const missing = [...needClip.filter(c => !L.clips.includes(c)), ...(!L.vaes.includes(rec.vae) ? [rec.vae] : [])];
                if (missing.length) throw new Error(`模型族「${family}」依赖文件缺失（ComfyUI 未枚举到）：${missing.join('、')}。请把缺少的文件放入 models/text_encoders 或 models/vae，或在 ComfyUI 安装支持包`);
            }
            wf = buildWorkflow(model_file, family, lorasList, st.size_mult, st.steps_mult, pr.positive, negative);
        }
        const clientId = crypto.randomUUID();
        const resp = await comfyPost('/prompt', { prompt: wf, client_id: clientId }, 60000);
        const pid = resp.prompt_id;
        log('[gen] 已提交', pid);
        await waitComfy(pid, clientId, 900000);
        const hist = await comfyGet('/history/' + pid);
        let png = '';
        const node = hist[pid] || {};
        for (const [_nid, nout] of Object.entries(node.outputs || {})) {
            for (const img of nout.images || []) {
                const sub = img.subfolder || '';
                const localP = comfyOutputRoot() ? path.join(comfyOutputRoot(), sub, img.filename) : '';
                if (localP && fs.existsSync(localP)) png = localP;
                else png = await comfyView(img.filename, sub, img.type || 'output');
            }
        }
        if (!png) throw new Error('完成但没找到输出图');
        const url = publish(png, pr.positive, st.auto_model || st.key || '模型', job.name);
        broadcast({ type: 'image', url, prompt: pr.positive.slice(0, 400), model: st.auto_model || st.key, name: job.name });
        job.result = { ok: true, png, url };
        log('[gen] DONE', url);
    } catch (e) {
        log('[gen] ERROR', e.message);
        if (cancelFlag) job.result = { ok: false, error: '已急停' };
        else { broadcast({ type: 'error', message: String(e.message || e).slice(0, 300) }); job.result = { ok: false, error: String(e.message || e) }; }
    }
    job.status = job.result?.ok ? 'done' : 'error';
    job.done = Date.now();
}

async function waitComfy(pid, clientId, timeoutMs) {
    const ws = new WebSocket(comfyUrl().replace(/^http/, 'ws') + '/ws?clientId=' + clientId);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('WS 等待超时')); }, timeoutMs);
        ws.onopen = () => log('[auto] WS 已连接', pid);
        ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                if (msg.type === 'execution_success' || (msg.type === 'execution_complete')) { clearTimeout(timer); ws.close(); resolve(); }
                if (msg.type === 'execution_interrupted') { clearTimeout(timer); ws.close(); reject(new Error('任务被中断')); }
                if (msg.type === 'execution_error') { clearTimeout(timer); ws.close(); reject(new Error('ComfyUI 执行错误')); }
            } catch { /* 忽略 */ }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('WS 连接失败')); };
    });
}

// ── 自定义工作流 ──
function loadWfCustom() {
    try { if (fs.existsSync(WF_CUSTOM_FILE)) { const d = JSON.parse(fs.readFileSync(WF_CUSTOM_FILE, 'utf8')); return { enabled: !!d.enabled, wf: d.wf || {} }; } } catch { /* 忽略 */ }
    return { enabled: false, wf: {} };
}
function applyWfCustom(wf, prompt, negative) {
    const out = {};
    for (const [nid, node] of Object.entries(wf)) {
        if (!node || typeof node !== 'object') continue;
        const inputs = {};
        for (const [k, v] of Object.entries(node.inputs || {})) inputs[k] = typeof v === 'string' ? v.replaceAll('{prompt}', prompt).replaceAll('{negative}', negative) : v;
        out[nid] = { class_type: node.class_type || '', inputs };
    }
    return out;
}

// ── SSE ──
function broadcast(ev) {
    const payload = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
}

// ── HTTP 服务 ──
let tasks = [];
const queue = [];
let workerBusy = false;
async function taskWorker() {
    if (workerBusy) return;
    workerBusy = true;
    try {
        while (queue.length) {
            const job = queue.shift();
            try { await runJob(job); } catch (e) { job.result = { ok: false, error: String(e) }; }
        }
    } finally { workerBusy = false; }
}
function enqueue(text, name) {
    const fp = crypto.createHash('sha1').update((text || '').trim()).digest('hex').slice(0, 16);
    const now = Date.now();
    if (lastGenFp.fp === fp && now - lastGenFp.ts < 60000) return { dup: true };
    lastGenFp = { fp, ts: now };
    const job = { id: new Date().toTimeString().slice(0, 8).replace(/:/g, '') + '-' + String(Date.now() % 1000), status: 'pending', created: now, done: 0, text, name, payload: { text, name }, result: {} };
    jobs.push(job);
    queue.push(job);
    taskWorker();
    return { job: job.id };
}

function jsonReply(res, obj, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(JSON.stringify(obj));
}
async function readBody(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    });
}

async function nodeTest() {
    const nodes = ['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'DualCLIPLoader', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage', 'EmptyLatentImage', 'EmptySD3LatentImage', 'LoraLoader'];
    const found = [];
    try {
        const oi = await comfyGet('/object_info');
        for (const n of nodes) if (oi[n]) found.push(n);
    } catch { /* 忽略 */ }
    const missing = nodes.filter(n => !found.includes(n));
    return { ok: missing.length === 0, missing, total: nodes.length, found: found.length };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }
        if (req.method === 'GET') {
            if (p === '/events') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
                res.write(': connected\n\n');
                sseClients.add(res);
                req.on('close', () => sseClients.delete(res));
                return;
            }
            if (p === '/health') return jsonReply(res, { status: 'ok', clients: sseClients.size, events: 0, model: ST.key, enabled: ST.enabled });
            if (p === '/model') {
                const force = url.searchParams.get('refresh') === '1';
                const r = { key: ST.key, loras: ST.loras, size_mult: ST.size_mult, steps_mult: ST.steps_mult, enabled: ST.enabled, options: {}, recipe: {}, auto_models: await autoModels(force), auto_model: ST.auto_model || '', family: ST.family || '' };
                return jsonReply(res, r);
            }
            if (p === '/loras') return jsonReply(res, { ok: true, loras: await loras(url.searchParams.get('refresh') === '1'), ts: Date.now() });
            if (p === '/jobs') { const j = jobs.map(x => ({ id: x.id, status: x.status, result: x.started_at && x.result })); return jsonReply(res, { jobs: j }); }
            if (p === '/comfycheck') { try { await comfyGet('/system_stats'); return jsonReply(res, { ok: true }); } catch (e) { return jsonReply(res, { ok: false, error: e.message }); } }
            if (p === '/nodetest') return jsonReply(res, await nodeTest());
            if (p === '/config') {
                loadCfg();
                return jsonReply(res, { comfy_url: ST.comfy_url, llm: { mode: ST.llm.mode, endpoint: ST.llm.endpoint, model: ST.llm.model, key_configured: !!ST.llm.key } });
            }
            if (p === '/prompt') {
                let over = '';
                try { if (fs.existsSync(PROMPT_EDIT_FILE)) over = fs.readFileSync(PROMPT_EDIT_FILE, 'utf8'); } catch { /* 忽略 */ }
                return jsonReply(res, { system: ENGINEER_SYSTEM, override: over, active: !!over.trim() });
            }
            if (p === '/workflow') { const wc = loadWfCustom(); return jsonReply(res, { ok: true, enabled: wc.enabled, wf: wc.wf }); }
            if (p === '/config/tavern') {
                const ta = readTavernApi();
                if (!ta.endpoint || !ta.key) return jsonReply(res, { ok: false, error: ta.err || '无法读取酒馆 API 配置' });
                ST.llm = { mode: 'tavern', endpoint: ta.endpoint, model: ta.model, key: ta.key };
                saveState();
                return jsonReply(res, { ok: true, endpoint: ta.endpoint, model: ta.model, key_configured: true });
            }
            if (p === '/paths') return jsonReply(res, { ok: true, model_root: ST.paths_model_root || '', lora_dir: ST.paths_lora_dir || '', recognized: ST.paths_recognized || '' });
            if (p === '/paths/dialog') {
                // Windows 文件夹选择器（PowerShell）；其它平台提示不支持
                const kind = url.searchParams.get('kind') || 'model';
                if (process.platform !== 'win32') return jsonReply(res, { ok: false, error: '非 Windows 不支持原生目录选择' });
                execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', '$f=New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq "OK"){Write-Output $f.SelectedPath}'], { timeout: 120000 }, (err, stdout) => {
                    const pth = (stdout || '').trim();
                    if (pth) jsonReply(res, { ok: true, path: pth.replace(/\\/g, '/') });
                    else jsonReply(res, { ok: false, error: '未选择或取消' });
                });
                return;
            }
            return jsonReply(res, { ok: false, error: 'not found: ' + p }, 404);
        }
        if (req.method === 'POST') {
            const data = await readBody(req);
            if (p === '/push') { broadcast({ type: 'image', ...data, ts: Date.now() / 1000 }); return jsonReply(res, { ok: true }); }
            if (p === '/enabled') { ST.enabled = !!data.enabled; saveState(); return jsonReply(res, { ok: true, enabled: ST.enabled }); }
            if (p === '/model') {
                if (typeof data.key === 'string') ST.key = data.key;
                if (Array.isArray(data.loras)) ST.loras = data.loras;
                if (data.size_mult) ST.size_mult = parseFloat(data.size_mult);
                if (data.steps_mult) ST.steps_mult = parseFloat(data.steps_mult);
                if (data.auto_model !== undefined) { ST.auto_model = String(data.auto_model || ''); ST.family = detectFamily(ST.auto_model); }
                saveState();
                return jsonReply(res, { ok: true, ...ST });
            }
            if (p === '/open-dir') {
                try {
                    const cwd0 = process.cwd();
                    const ourExt = [
                        path.join(cwd0, 'data', 'default-user', 'extensions', 'tavern-auto-img-extension'),
                        path.join(cwd0, 'data', 'default-user', 'extensions', 'TavernAutoImage'),
                        path.join(cwd0, 'public', 'scripts', 'extensions', 'third-party', 'tavern-auto-img-extension'),
                        path.join(cwd0, 'public', 'scripts', 'extensions', 'third-party', 'tavern-auto-img'),
                    ].find(p0 => fs.existsSync(p0));
                    const userExtDir = path.join(cwd0, 'data', 'default-user', 'extensions');
                    const globalExtDir = path.join(cwd0, 'public', 'scripts', 'extensions', 'third-party');
                    const d = ourExt || (fs.existsSync(globalExtDir) ? globalExtDir : userExtDir);
                    if (process.platform === 'win32') {
                        const { spawn } = await import('node:child_process');
                        const ch = spawn('explorer.exe', [d], { detached: true, stdio: 'ignore' });
                        ch.unref();
                    }
                    return jsonReply(res, { ok: true, dir: d });
                } catch (e) { return jsonReply(res, { ok: false, error: String(e.message || e) }); }
            }
            if (p === '/uninstall') {
                // 卸载桥：删除 plugins 里的桥文件 + 关闭 enableServerPlugins + 自动重启酒馆
                try {
                    const pf = path.join(process.cwd(), 'plugins', 'tavern-auto-img-bridge.mjs');
                    let removed = false;
                    if (fs.existsSync(pf)) { fs.rmSync(pf, { force: true }); removed = true; }
                    const cfgP = path.join(process.cwd(), 'config.yaml');
                    let cfgClosed = false;
                    if (fs.existsSync(cfgP)) {
                        const c = fs.readFileSync(cfgP, 'utf8');
                        const c2 = c.replace(/enableServerPlugins:\s*true/, 'enableServerPlugins: false');
                        if (c2 !== c) { fs.writeFileSync(cfgP, c2, 'utf8'); cfgClosed = true; }
                    }
                    // 异步重启酒馆（本桥随酒馆进程一起结束）
                    const { spawn } = await import('node:child_process');
                    const me = process.pid;
                    const ps = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
                        `Start-Sleep 2; Stop-Process -Id ${me} -Force -ErrorAction SilentlyContinue; Start-Sleep 1; Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '${process.cwd()}' -WindowStyle Hidden`], { detached: true, stdio: 'ignore' });
                    ps.unref();
                    return jsonReply(res, { ok: true, removed, config_closed: cfgClosed, restart: true });
                } catch (e) { return jsonReply(res, { ok: false, error: String(e.message || e) }); }
            }
            if (p === '/cancel') {
                cancelFlag = true;
                if (currentProc && !currentProc.killed) { try { currentProc.kill(); } catch { /* 忽略 */ } }
                try { await comfyPost('/interrupt', {}); } catch { /* 忽略 */ }
                const q = await comfyGet('/queue');
                const del = (q.queue_pending || []).map(x => x[1]);
                if (del.length) try { await comfyPost('/queue', { delete: del }); } catch { /* 忽略 */ }
                lastGenFp = { fp: '', ts: 0 };
                broadcast({ type: 'stage', stage: 'cancel', msg: '🛑 任务已急停' });
                return jsonReply(res, { ok: true, removed: del.length });
            }
            if (p === '/generate') {
                const text = String(data.text || '').trim();
                if (text.length < 10) return jsonReply(res, { ok: false, error: 'text 太短' }, 400);
                const r = enqueue(text, data.name || '生图');
                if (r.dup) return jsonReply(res, { ok: false, dup: true, error: '该回复 60 秒内已触发过出图（去重拦截）' }, 429);
                return jsonReply(res, { ok: true, job: r.job }, 202);
            }
            if (p === '/config') {
                if (data.comfy_url !== undefined) ST.comfy_url = String(data.comfy_url);
                if (data.llm) { ST.llm = { ...ST.llm, ...data.llm }; }
                saveState(); loadCfg(); saveCfgIfNoFile();
                return jsonReply(res, { ok: true });
            }
            if (p === '/config/test') {
                const over = data.llm || ST.llm;
                const endpoint = (over.endpoint || '').replace(/\/+$/, '');
                const t0 = Date.now();
                try {
                    const r = await fetch(endpoint + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (over.key || '') }, body: JSON.stringify({ model: over.model || 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }), signal: AbortSignal.timeout(30000) });
                    if (!r.ok) return jsonReply(res, { ok: false, error: `HTTP ${r.status}` });
                    return jsonReply(res, { ok: true, latency_ms: Date.now() - t0 });
                } catch (e) { return jsonReply(res, { ok: false, error: e.message }); }
            }
            if (p === '/models') {
                const endpoint = String(data.endpoint || '').trim().replace(/\/+$/, '');
                const key = String(data.key || '');
                try {
                    const r = await fetch(endpoint + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) });
                    if (!r.ok) return jsonReply(res, { ok: false, error: 'HTTP ' + r.status });
                    const d = await r.json();
                    const ids = (d.data || d.models || []).map(x => typeof x === 'string' ? x : (x.id || x.name || '')).filter(Boolean);
                    return jsonReply(res, { ok: true, models: ids.slice(0, 100) });
                } catch (e) { return jsonReply(res, { ok: false, error: e.message }); }
            }
            if (p === '/prompt') {
                try {
                    const sys = String(data.system || '').trim();
                    if (sys) fs.writeFileSync(PROMPT_EDIT_FILE, sys, 'utf8');
                    else if (fs.existsSync(PROMPT_EDIT_FILE)) fs.unlinkSync(PROMPT_EDIT_FILE);
                    return jsonReply(res, { ok: true, active: !!sys });
                } catch (e) { return jsonReply(res, { ok: false, error: e.message }, 500); }
            }
            if (p === '/workflow') {
                const wf = data.wf || {};
                if (typeof wf !== 'object' || Array.isArray(wf)) return jsonReply(res, { ok: false, error: '工作流必须是节点对象' }, 400);
                fs.writeFileSync(WF_CUSTOM_FILE, JSON.stringify({ enabled: !!data.enabled, wf }, null, 2), 'utf8');
                return jsonReply(res, { ok: true, enabled: !!data.enabled, nodes: Object.keys(wf).length });
            }
            return jsonReply(res, { ok: false, error: 'not found: ' + p }, 404);
        }
    } catch (e) {
        log('[http] 错误', p, e.message);
        try { jsonReply(res, { ok: false, error: e.message }, 500); } catch { /* 忽略 */ }
    }
});

export const info = {
    id: 'tavern-auto-img',
    name: 'Tavern Auto Image 桥',
    description: '酒馆自动文生图服务端桥（角色回复 → 提示词 → ComfyUI 出图），监听端口 8645',
};

export async function init() {
    // bridge 已在模块加载时由顶层 listen 启动；这里仅返回清理函数
    return () => {
        try {
            server.closeAllConnections?.();
            server.close();
        } catch { /* 忽略 */ }
    };
}

// 模块加载即启动（酒馆 import 插件 / 直接 node 运行 均为同一路径）
server.listen(PORT, () => {
    log(`[bridge] tavern-auto-img Node 桥已启动 http://127.0.0.1:${PORT}（随酒馆运行）`);
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'bridge.pid'), String(process.pid), 'utf8'); } catch { /* 忽略 */ }
});
