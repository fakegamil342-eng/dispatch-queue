// Live dispatch queue status page — professional design with WhatsApp chat widget.
// Accessible at https://dispatch-queue.vercel.app/api/status-page
const GH_API = 'https://api.github.com';
const GH_OWNER = 'Iswardahal142';
const GH_REPO = 'dispatch-queue';
const GH_BRANCH = 'main';

function ghToken() {
  const t = process.env.GITHUB_QUEUE_TOKEN;
  if (!t) throw new Error('GITHUB_QUEUE_TOKEN missing');
  return t;
}

async function ghGet(path) {
  const res = await fetch(GH_API + path, {
    headers: {
      'Authorization': 'Bearer ' + ghToken(),
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'dispatch-queue',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`);
  return res.json();
}

async function ghListDir(dir) {
  const data = await ghGet(`/repos/${GH_OWNER}/${GH_REPO}/contents/${dir}?ref=${GH_BRANCH}`);
  if (!data || !Array.isArray(data)) return [];
  return data.filter(f => f.type === 'file' && f.name.endsWith('.json'));
}

async function ghReadJson(path) {
  const data = await ghGet(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`);
  if (!data || !data.content) return null;
  try {
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  } catch (e) { return null; }
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const AVATARS = {'video-1':'🔵','video-2':'🟠','video-3':'🟣','main':'👑'};
function avatar(name){ return AVATARS[name] || '👤'; }

function rel(ts, now) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

module.exports = async (req, res) => {
  try {
    const now = Date.now();

    // GitHub API rate-limit usage — /rate_limit khud limit me count nahi hota
    let rl = null;
    try {
      const rld = await ghGet('/rate_limit');
      if (rld && rld.resources && rld.resources.core) rl = rld.resources.core;
    } catch (e) { rl = null; }

    const hbFiles = await ghListDir('queue/heartbeats');
    const heartbeats = [];
    for (const f of hbFiles) {
      const d = await ghReadJson(f.path);
      if (d) heartbeats.push(d);
    }
    heartbeats.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

    const tasks = {};
    for (const st of ['pending', 'claimed', 'done', 'failed']) {
      tasks[st] = [];
      for (const f of await ghListDir(`queue/tasks/${st}`)) {
        const d = await ghReadJson(f.path);
        if (d) tasks[st].push(d);
      }
      tasks[st].sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    }

    const notices = [];
    for (const f of await ghListDir('queue/notices')) {
      const d = await ghReadJson(f.path);
      if (d) notices.push(d);
    }

    const msgFiles = await ghListDir('queue/messages');
    const messages = [];
    for (const f of msgFiles) {
      const d = await ghReadJson(f.path);
      if (d) messages.push(d);
    }
    messages.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

    const claimedBy = {};
    for (const t of tasks.claimed) {
      claimedBy[t.claimedBy || '?'] = (claimedBy[t.claimedBy || '?'] || 0) + 1;
    }

    const totalTasks = tasks.pending.length + tasks.claimed.length + tasks.done.length + tasks.failed.length;

    // Rate-limit display values
    const rlUsed = rl ? rl.used : null;
    const rlLimit = rl ? rl.limit : 5000;
    const rlPct = rlUsed != null ? Math.min(100, Math.round(rlUsed / rlLimit * 100)) : 0;
    const rlResetMin = rl ? Math.max(0, Math.round((rl.reset * 1000 - now) / 60000)) : null;
    const rlColor = rlPct >= 80 ? '#ff5252' : rlPct >= 60 ? '#ffc107' : '#25d366';
    const aliveWorkers = heartbeats.filter(h => (now - (h.timestampMs || 0)) < 15 * 60 * 1000).length;

    // Build chat messages HTML for the modal
    let chatHtml = '';
    for (const m of messages.slice(0, 30)) {
      const isMain = m.from === 'main';
      chatHtml += `<div class="wa-msg ${isMain ? 'wa-right' : 'wa-left'}">
        <div class="wa-sender wa-${esc(m.from)}">${avatar(m.from)} ${esc(m.from)} <span style="font-weight:400;opacity:.7">→ ${esc(m.to)}</span></div>
        <div class="wa-text">${esc(m.text)}</div>
        <div class="wa-time">${esc(rel(m.createdAtMs, now))}</div>
      </div>`;
    }
    if (!messages.length) chatHtml = '<div class="wa-empty">No messages yet</div>';

    const h = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dispatch Queue · Live Status</title>
<meta http-equiv="refresh" content="90">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1419;--card:#1a2230;--border:#2a3444;--text:#e8edf3;--muted:#8b98a9;--accent:#25d366;--accent-dark:#128c7e}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:0 0 100px}
.header{background:linear-gradient(135deg,#0d2818,#1a2230);padding:28px 20px 22px;border-bottom:1px solid var(--border)}
.header h1{font-size:22px;font-weight:700;letter-spacing:-.3px}
.header p{color:var(--muted);font-size:13px;margin-top:6px}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:6px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.wrap{max-width:720px;margin:0 auto;padding:16px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 10px;text-align:center}
.stat .num{font-size:26px;font-weight:800}
.stat .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px}
.card h2{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:12px}
.worker{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)}
.worker:last-child{border-bottom:none}
.worker .name{font-weight:600;font-size:15px}
.pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.4px}
.pill.alive{background:rgba(37,211,102,.15);color:var(--accent)}
.pill.stale{background:rgba(139,152,169,.15);color:var(--muted)}
.pill.pending{background:rgba(255,193,7,.15);color:#ffc107}
.pill.claimed{background:rgba(37,211,102,.15);color:var(--accent)}
.pill.done{background:rgba(139,152,169,.15);color:var(--muted)}
.pill.failed{background:rgba(220,53,69,.15);color:#dc3545}
.task-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:14px}
.task-row:last-child{border:none}
.task-row .t{flex:1;margin-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:12px;color:var(--muted)}
.notice{padding:10px 0;border-bottom:1px solid var(--border)}
.notice:last-child{border:none}
.notice .nt{font-weight:600;font-size:14px}
.notice .nx{font-size:13px;color:var(--muted);margin-top:2px}
/* WhatsApp floating button */
.wa-fab{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(37,211,102,.4);z-index:1000;border:none;transition:transform .2s}
.wa-fab:hover{transform:scale(1.08)}
.wa-fab svg{width:32px;height:32px;fill:#fff}
.wa-badge{position:absolute;top:-4px;right:-4px;background:#ff3b30;color:#fff;font-size:11px;font-weight:700;min-width:22px;height:22px;border-radius:11px;display:flex;align-items:center;justify-content:center;padding:0 6px}
/* Chat modal */
.wa-modal{display:none;position:fixed;inset:0;z-index:1001;background:rgba(0,0,0,.6);backdrop-filter:blur(2px)}
.wa-modal.open{display:flex;align-items:flex-end;justify-content:center}
@media(min-width:600px){.wa-modal.open{align-items:center}}
.wa-window{width:100%;max-width:440px;height:75vh;max-height:640px;background:#e5ddd5;border-radius:16px 16px 0 0;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 -4px 30px rgba(0,0,0,.3)}
@media(min-width:600px){.wa-window{border-radius:16px}}
.wa-header{background:#075e54;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px}
.wa-avatar{width:40px;height:40px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:20px}
.wa-header .tt{font-weight:700;font-size:16px}
.wa-header .st{font-size:12px;opacity:.8}
.wa-close{margin-left:auto;background:none;border:none;color:#fff;font-size:24px;cursor:pointer;opacity:.8}
.wa-body{flex:1;overflow-y:auto;padding:16px 12px;display:flex;flex-direction:column;gap:8px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Ccircle cx='40' cy='40' r='1.5' fill='%23000' opacity='.04'/%3E%3C/svg%3E")}
.wa-msg{max-width:78%;padding:8px 12px;border-radius:10px;font-size:14px;line-height:1.45;box-shadow:0 1px 1px rgba(0,0,0,.12);animation:slideIn .25s ease}
@keyframes slideIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.wa-left{align-self:flex-start;background:#fff;color:#222;border-top-left-radius:2px}
.wa-right{align-self:flex-end;background:#dcf8c6;color:#222;border-top-right-radius:2px}
.wa-sender{font-size:11px;font-weight:700;color:#128c7e;margin-bottom:2px}
.wa-video-1{color:#1565c0}
.wa-video-2{color:#e65100}
.wa-video-3{color:#6a1b9a}
.wa-right .wa-sender{color:#0d7a6e}
.wa-text{word-wrap:break-word}
.wa-time{font-size:10px;color:#888;text-align:right;margin-top:3px}
.wa-empty{text-align:center;color:#888;font-size:14px;margin-top:40px}
.notice.is-new{border:1px solid #ffc107;border-radius:10px;padding:10px;background:rgba(255,193,7,.06);animation:glowPulse 2s infinite}
@keyframes glowPulse{0%,100%{box-shadow:0 0 0 rgba(255,193,7,0)}50%{box-shadow:0 0 12px rgba(255,193,7,.35)}}
.new-badge{background:#ffc107;color:#000;font-size:10px;font-weight:800;padding:2px 8px;border-radius:10px;vertical-align:middle}
.wa-input-row{display:flex;gap:8px;padding:10px;background:#f0f0f0}
.wa-input{flex:1;border:1px solid #ddd;border-radius:20px;padding:10px 14px;font-size:14px;outline:none}
.wa-send{background:#25d366;border:none;color:#fff;width:44px;height:44px;border-radius:50%;font-size:18px;cursor:pointer;flex-shrink:0}
.wa-send:disabled{opacity:.5}
.qform{display:flex;flex-direction:column;gap:10px}
.qform input,.qform select{width:100%;background:#0f1419;border:1px solid var(--border);border-radius:10px;padding:12px;color:var(--text);font-size:14px;outline:none}
.qform input:focus,.qform select:focus{border-color:var(--accent)}
.qform .row{display:flex;gap:10px}
.qform .row>*{flex:1}
.qbtn{background:#25d366;border:none;color:#fff;font-weight:700;font-size:15px;padding:13px;border-radius:12px;cursor:pointer}
.hamb{background:none;border:none;color:#e8edf3;font-size:24px;cursor:pointer;padding:4px 8px;margin-right:8px}
.sidebar{position:fixed;top:0;left:0;bottom:0;width:300px;max-width:85vw;background:#1a2230;border-right:1px solid var(--border);z-index:1500;transform:translateX(-105%);transition:transform .28s ease;display:flex;flex-direction:column}
.sidebar.open{transform:none}
.sb-head{display:flex;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid var(--border)}
.sb-head .t{font-weight:700;font-size:16px}
.sb-close{background:none;border:none;color:#8b98a9;font-size:24px;cursor:pointer}
.sb-body{flex:1;overflow-y:auto;padding:16px}
.sb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1400;display:none}
.sb-overlay.open{display:block}
.qbtn:disabled{opacity:.5}
.wa-footer{background:#f0f0f0;padding:10px 14px;font-size:12px;color:#888;text-align:center}
</style></head><body>
<!-- PIN gate -->
<div id="pinGate" style="position:fixed;inset:0;background:#0f1419;z-index:2000;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:20px">
  <div style="font-size:52px">🔐</div>
  <div style="color:#e8edf3;font-size:20px;font-weight:700">Dispatch Queue</div>
  <div style="color:#8b98a9;font-size:13px">PIN daalo</div>
  <div id="pinBoxes" style="display:flex;gap:8px">
    <input class="pinbox" type="password" inputmode="numeric" maxlength="1" style="width:48px;height:56px;background:#1a2230;border:1px solid #2a3444;border-radius:12px;color:#e8edf3;font-size:24px;text-align:center;outline:none">
    <input class="pinbox" type="password" inputmode="numeric" maxlength="1" style="width:48px;height:56px;background:#1a2230;border:1px solid #2a3444;border-radius:12px;color:#e8edf3;font-size:24px;text-align:center;outline:none">
    <input class="pinbox" type="password" inputmode="numeric" maxlength="1" style="width:48px;height:56px;background:#1a2230;border:1px solid #2a3444;border-radius:12px;color:#e8edf3;font-size:24px;text-align:center;outline:none">
    <input class="pinbox" type="password" inputmode="numeric" maxlength="1" style="width:48px;height:56px;background:#1a2230;border:1px solid #2a3444;border-radius:12px;color:#e8edf3;font-size:24px;text-align:center;outline:none">
    <input class="pinbox" type="password" inputmode="numeric" maxlength="1" style="width:48px;height:56px;background:#1a2230;border:1px solid #2a3444;border-radius:12px;color:#e8edf3;font-size:24px;text-align:center;outline:none">
    <input class="pinbox" type="password" inputmode="numeric" maxlength="1" style="width:48px;height:56px;background:#1a2230;border:1px solid #2a3444;border-radius:12px;color:#e8edf3;font-size:24px;text-align:center;outline:none">
  </div>
  <button id="pinBtn" style="background:#25d366;border:none;color:#fff;font-weight:700;font-size:16px;padding:13px 48px;border-radius:12px;cursor:pointer">Unlock</button>
  <div id="pinErr" style="color:#ff5252;font-size:14px;display:none">❌ Galat PIN!</div>
</div>
<div class="header">
  <h1><button class="hamb" id="hambBtn" aria-label="Menu">☰</button><span class="live-dot"></span>Dispatch Queue</h1>
  <p>Live status · ${new Date(now).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})} IST · GitHub backend · auto-refresh 90s</p>
</div>
<div class="wrap">
  <div class="stats">
    <div class="stat"><div class="num">${aliveWorkers}</div><div class="lbl">Workers</div></div>
    <div class="stat"><div class="num" style="color:#ffc107">${tasks.pending.length}</div><div class="lbl">Pending</div></div>
    <div class="stat"><div class="num" style="color:#25d366">${tasks.claimed.length}</div><div class="lbl">Claimed</div></div>
    <div class="stat"><div class="num">${totalTasks}</div><div class="lbl">Total</div></div>
  </div>

  <div class="card"><h2>⚡ GitHub API <span style="font-size:12px;color:#8b98a9;font-weight:400">per hour</span></h2>
    ${rlUsed != null ? `
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px">
      <div style="font-size:22px;font-weight:700;color:${rlColor}">${rlUsed.toLocaleString('en-IN')} <span style="font-size:13px;color:#8b98a9;font-weight:400">/ ${rlLimit.toLocaleString('en-IN')}</span></div>
      <div class="meta">resets in ~${rlResetMin} min</div>
    </div>
    <div style="height:8px;background:#1a2230;border-radius:6px;margin-top:10px;overflow:hidden"><div style="height:100%;width:${rlPct}%;background:${rlColor};border-radius:6px;transition:width .5s"></div></div>
    ` : '<div class="meta">rate info unavailable</div>'}
  </div>

  <div class="card"><h2>Workers</h2>
    ${heartbeats.length ? heartbeats.map(hb => {
      const alive = (now - (hb.timestampMs || 0)) < 15 * 60 * 1000;
      const busy = claimedBy[hb.worker] || 0;
      return `<div class="worker"><div><div class="name">${avatar(hb.worker)} ${esc(hb.worker)}</div><div class="meta">${rel(hb.timestampMs, now)}${busy ? ` · ${busy} task${busy>1?'s':''}` : ''}</div></div><span class="pill ${alive ? 'alive' : 'stale'}">${alive ? 'alive' : 'stale'}</span></div>`;
    }).join('') : '<div class="meta">No heartbeats yet — workers will appear on next poll</div>'}
  </div>

  ${['pending','claimed'].map(st => tasks[st].length ? `<div class="card"><h2>${st === 'pending' ? '⏳ Pending' : '🔨 Claimed'} · ${tasks[st].length}</h2>` +
    tasks[st].slice(0, 12).map(t => `<div class="task-row"><div class="t">${esc((t.title || '?').slice(0, 55))}${t.assignTo ? ` <span class="meta">→ ${esc(t.assignTo)}</span>` : ''}${st === 'claimed' ? ` <span class="meta">· ${esc(t.claimedBy || '?')}</span>` : ''}</div><span class="pill ${st}">${st}</span></div>`).join('') + `</div>` : '').join('')}

  ${notices.length ? `<div class="card"><h2>📢 Notices</h2>` + notices.map(n => `<div class="notice" data-nkey="${esc(n.key || n.title)}"><div class="nt">${esc(n.title || n.key)} <span class="new-badge" style="display:none">NEW</span></div><div class="nx">${esc((n.text || '').slice(0, 150))}</div></div>`).join('') + `</div>` : ''}

  <div class="card"><h2>📊 All time</h2>
    <div class="task-row"><div class="t">Completed</div><span class="pill done">${tasks.done.length}</span></div>
    <div class="task-row"><div class="t">Failed</div><span class="pill failed">${tasks.failed.length}</span></div>
  </div>
</div>

<!-- WhatsApp chat FAB -->
<button class="wa-fab" id="waFab" aria-label="Open messages">
  <svg viewBox="0 0 24 24"><path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.9 1.22 3.1.15.2 2.1 3.2 5.1 4.49.71.31 1.27.49 1.7.63.72.23 1.37.2 1.88.12.57-.09 1.76-.72 2-1.42.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35M12.05 21.8h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.9-9.88a9.83 9.83 0 0 1 9.88 9.89c0 5.45-4.44 9.88-9.89 9.88M20.5 3.5A11.8 11.8 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.9c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.9 11.9 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.9 0-3.18-1.24-6.16-3.44-8.4"/></svg>
  <span class="wa-badge" id="waBadge" style="display:none"></span>
</button>

<script>
// PIN gate — sessionStorage (refresh par nahi maangega, browser close par reset)
(function(){
  var gate = document.getElementById('pinGate');
  var pinErr = document.getElementById('pinErr');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.pinbox'));
  var metaR = document.querySelector('meta[http-equiv="refresh"]');
  function unlock(pin){
    // Gate ko DOM se hatao (chat modal se conflict khatm), refresh wapas lagao
    sessionStorage.setItem('dq_pin', pin);
    window.DQ_PIN = pin;
    gate.remove();
    if (metaR) document.head.appendChild(metaR);
  }
  if (sessionStorage.getItem('dq_pin')) {
    window.DQ_PIN = sessionStorage.getItem('dq_pin');
    gate.remove();
    return;
  }
  if (metaR) metaR.remove();
  boxes[0].focus();
  // Auto-advance + backspace navigation (Durga Puja OTP style)
  boxes.forEach(function(box, i){
    box.addEventListener('input', function(){
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      // Sab bhar gaye toh auto-verify
      var pin = boxes.map(function(b){ return b.value; }).join('');
      if (pin.length === 6) check(pin);
    });
    box.addEventListener('keydown', function(e){
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === 'Enter') {
        var pin = boxes.map(function(b){ return b.value; }).join('');
        check(pin);
      }
    });
  });
  function check(pin){
    if (!pin || pin.length !== 6) return;
    fetch('/api/quick-action', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'verify-pin', pin: pin})
    }).then(function(r){ return r.json(); }).then(function(d){
      if (d.ok) {
        unlock(pin);
      } else {
        pinErr.style.display = 'block';
        boxes.forEach(function(b){ b.value = ''; });
        boxes[0].focus();
      }
    }).catch(function(){ pinErr.style.display = 'block'; });
  }
  document.getElementById('pinBtn').addEventListener('click', function(){
    check(boxes.map(function(b){ return b.value; }).join(''));
  });
})();
// Track seen messages in localStorage — badge shows only unseen count
(function(){
  var SEEN_KEY = 'wa_seen_msgs';
  function getSeen(){ try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch(e){ return []; } }
  function saveSeen(ids){ try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch(e){} }
  // Message IDs rendered on this page
  var allIds = [${messages.slice(0, 30).map(m => `'${(m.id || '').replace(/'/g, '')}'`).join(',')}];
  var seen = getSeen();
  var unseen = allIds.filter(function(id){ return id && seen.indexOf(id) === -1; });
  var badge = document.getElementById('waBadge');
  var fab = document.getElementById('waFab');
  function updateBadge(){
    if (unseen.length > 0) {
      badge.style.display = 'flex';
      badge.textContent = unseen.length > 99 ? '99+' : unseen.length;
    } else {
      badge.style.display = 'none';
    }
  }
  updateBadge();
  // Notice NEW highlight — track seen notice keys
  (function(){
    var NK = 'seen_notices';
    function getN(){ try { return JSON.parse(localStorage.getItem(NK) || '[]'); } catch(e){ return []; } }
    var seenN = getN();
    var fresh = [];
    document.querySelectorAll('.notice[data-nkey]').forEach(function(el){
      var k = el.getAttribute('data-nkey');
      if (seenN.indexOf(k) === -1) {
        el.classList.add('is-new');
        var b = el.querySelector('.new-badge');
        if (b) b.style.display = 'inline-block';
        fresh.push(k);
      }
    });
    if (fresh.length) {
      try { localStorage.setItem(NK, JSON.stringify(seenN.concat(fresh))); } catch(e){}
    }
  })();
  // Quick actions: send message + create task via /api/quick-action
  (function(){
    var sendBtn = document.getElementById('waSend');
    var txt = document.getElementById('waText');
    var toSel = document.getElementById('waTo');
    function sendMsg(){
      var t = txt.value.trim();
      if (!t) return;
      sendBtn.disabled = true;
      fetch('/api/quick-action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'send-message', to: toSel.value, text: t, pin: window.DQ_PIN})
      }).then(function(r){ return r.json(); }).then(function(d){
        if (d.error) { alert('Error: ' + d.error); }
        else { txt.value = ''; location.reload(); }
      }).catch(function(e){ alert('Failed: ' + e.message); })
      .finally(function(){ sendBtn.disabled = false; });
    }
    sendBtn.addEventListener('click', sendMsg);
    txt.addEventListener('keydown', function(e){ if (e.key === 'Enter') sendMsg(); });

    var qBtn = document.getElementById('qtBtn');
    qBtn.addEventListener('click', function(){
      var title = document.getElementById('qtTitle').value.trim();
      if (!title) { alert('Title likho!'); return; }
      qBtn.disabled = true;
      qBtn.textContent = 'Creating...';
      fetch('/api/quick-action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          action: 'create-task',
          pin: window.DQ_PIN,
          title: title,
          assignTo: document.getElementById('qtWorker').value,
          tag: document.getElementById('qtTag').value.trim(),
          note: document.getElementById('qtNote').value.trim()
        })
      }).then(function(r){ return r.json(); }).then(function(d){
        if (d.error) { alert('Error: ' + d.error); }
        else { alert('Task ban gaya! ID: ' + (d.taskId || '')); location.reload(); }
      }).catch(function(e){ alert('Failed: ' + e.message); })
      .finally(function(){ qBtn.disabled = false; qBtn.textContent = 'Create Task'; });
    });
  })();
  // Hamburger sidebar — default closed, bahar tap se close
  (function(){
    var sb = document.getElementById('sidebar');
    var ov = document.getElementById('sbOverlay');
    function openSb(){ sb.classList.add('open'); ov.classList.add('open'); }
    function closeSb(){ sb.classList.remove('open'); ov.classList.remove('open'); }
    document.getElementById('hambBtn').addEventListener('click', openSb);
    document.getElementById('sbClose').addEventListener('click', closeSb);
    ov.addEventListener('click', closeSb);
  })();
  fab.addEventListener('click', function(){
    document.getElementById('waModal').classList.add('open');
    // Mark all as seen when opening chat
    var updated = seen.concat(unseen);
    saveSeen(updated);
    unseen = [];
    setTimeout(updateBadge, 300);
  });
})();
</script>

<!-- Chat modal -->
<div class="wa-modal" id="waModal" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="wa-window">
    <div class="wa-header">
      <div class="wa-avatar">📡</div>
      <div><div class="tt">Queue Messages</div><div class="st">${messages.length} message${messages.length !== 1 ? 's' : ''} · live</div></div>
      <button class="wa-close" onclick="document.getElementById('waModal').classList.remove('open')">×</button>
    </div>
    <div class="wa-body">${chatHtml}</div>
    <div class="wa-input-row">
      <select id="waTo" class="wa-input" style="flex:0 0 110px">
        <option value="video-1">🔵 video-1</option>
        <option value="video-2">🟠 video-2</option>
        <option value="video-3">🟣 video-3</option>
      </select>
      <input id="waText" class="wa-input" placeholder="Message likho..." maxlength="2000">
      <button id="waSend" class="wa-send">➤</button>
    </div>
  </div>
</div>

<!-- Hamburger sidebar -->
<div class="sb-overlay" id="sbOverlay"></div>
<aside class="sidebar" id="sidebar">
  <div class="sb-head">
    <div class="t">➕ Quick Task</div>
    <button class="sb-close" id="sbClose">×</button>
  </div>
  <div class="sb-body">
    <div class="qform">
      <input id="qtTitle" placeholder="Task title... (e.g. Day 11 voiceover)">
      <div class="row">
        <select id="qtWorker">
          <option value="any">Anyone (first free)</option>
          <option value="video-1">🔵 video-1</option>
          <option value="video-2">🟠 video-2</option>
          <option value="video-3">🟣 video-3</option>
        </select>
        <input id="qtTag" placeholder="tag (e.g. video)">
      </div>
      <input id="qtNote" placeholder="Note / instructions (optional)">
      <button id="qtBtn" class="qbtn">Create Task</button>
    </div>
  </div>
</aside>
</body></html>`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(h);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>Error</h1><p>${esc(err.message)}</p>`);
  }
};
// deploy-trigger 2026-10-02T20:31:06Z
// deploy-trigger 2026-10-02T23:30:20Z
// deploy-trigger 2026-10-03T02:28:14Z
// deploy-trigger 2026-10-03T05:27:24Z
// deploy-trigger 2026-10-03T08:27:05Z
// deploy-trigger 2026-10-03T11:27:13Z
// deploy-trigger 2026-10-03T11:30:00Z
