// ═══════════════════════════════════════════════════════════════════
// Tavern Auto Image — 独立「更新」模块 v1（2026-09-08 模块化第 1 弹）
// 定位：不触碰 index.js 任何业务逻辑；只在面板"📋出图日志"旁挂一个"🔄 检查更新"入口
// 行为：检查 Gitee/GitHub 最新 commit → 对比本地版本号 → 提示最新/有新版 + 更新方式
// 更新方式：浏览器无法写盘，采用 ST 官方路径（酒馆 ⚙扩展 → 该扩展 → 更新 / 重装）
// ═══════════════════════════════════════════════════════════════════

// 本地版本号（与 index.js 初始化版号日志同步；发版时两处一起更）
export const TA_VER = 'v3.0-10238e3';

const SRC = [
    { name: 'Gitee', url: 'https://gitee.com/api/v5/repos/SKYEzzyy/tavern-auto-img-extension/commits?sha=master&per_page=1' },
    { name: 'GitHub', url: 'https://api.github.com/repos/skyyy231/tavern-auto-img-extension/commits?sha=master&per_page=1' },
];

export function initTaUpdate() {
    if (window.__taUpdateInit) return;
    window.__taUpdateInit = true;

    const tryMount = function () {
        const $log = $('#ta-img-log2');
        if ($log && $log.length) {
            if (!document.getElementById('ta-img-update')) {
                $('<span id="ta-img-update" title="检查 Gitee/GitHub 上有没有新版本；有新版 → 酒馆 ⚙扩展 → 自动文生图 → 更新" ' +
                    'style="cursor:pointer;font-size:15px;color:#fbbf24;padding:5px 12px;border-radius:8px;' +
                    'border:1px solid rgba(251,191,36,.4);white-space:nowrap;flex-shrink:0;">🔄 检查更新</span>')
                    .on('click', onCheckUpdate)
                    .insertAfter($log);
            }
            return true;
        }
        return false;
    };

    // 面板是 index.js 异步构建的 → 观察/轮询等 #ta-img-log2 出现后挂按钮（只挂一次）
    if (!tryMount()) {
        let tries = 0;
        const mo = new MutationObserver(function () {
            if (tryMount()) mo.disconnect();
        });
        try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* 忽略 */ }
        const iv = setInterval(function () { if (tryMount() || ++tries > 60) clearInterval(iv); }, 500);
    }

    async function onCheckUpdate() {
        const $btn = $('#ta-img-update');
        if ($btn) $btn.text('⏳ 检查中…');
        const results = [];
        for (const s of SRC) {
            try {
                const r = await fetch(s.url, { signal: AbortSignal.timeout(10000) });
                if (!r.ok) { results.push({ ok: false, name: s.name, msg: 'HTTP ' + r.status }); continue; }
                const arr = await r.json();
                const first = Array.isArray(arr) ? arr[0] : arr;
                const sha = (first && first.sha) || '';
                const date = (first && first.commit && first.commit.author && first.commit.author.date) || '';
                if (sha) results.push({ ok: true, name: s.name, sha: String(sha).slice(0, 7), date: String(date).slice(0, 10) });
                else results.push({ ok: false, name: s.name, msg: '无数据' });
            } catch (e) {
                results.push({ ok: false, name: s.name, msg: String(e.message || e).slice(0, 40) });
            }
        }
        const local = (TA_VER.split('-').pop() || '').slice(0, 7);
        const newest = results.find(x => x.ok && x.sha);
        const isNew = !!newest && newest.sha !== local;
        const lines = results.map(x => (x.ok ? '🟢 ' : '🔴 ') + x.name + '：' + (x.ok ? x.sha + '（' + x.date + '）' : (x.msg || '连不上')));
        const msg =
            '本地版本：' + local + '\n' + lines.join('\n') + '\n\n' +
            (isNew
                ? '⚠️ 有新版（' + newest.sha + '）！\n更新：酒馆 ⚙扩展图标 → 自动文生图 → 更新\n（或去 Gitee/GitHub 重新安装）'
                : '✅ 已是最新版。');
        (isNew ? toastr.info : toastr.success)(msg, '🔄 检查更新', { timeOut: 15000, newestOnTop: true });
        console.log('[ta-img][update] 检查结果：', local, '→', results.map(x => (x.ok ? x.sha : x.msg)).join(' / '), isNew ? '（有新版）' : '（已最新）');
        if ($btn) $btn.text('🔄 检查更新');
    }
}
