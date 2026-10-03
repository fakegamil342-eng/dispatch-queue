// Live owner status page — GET /api/status?token=<DISPATCH_MAIN_TOKEN>
//
// Server-rendered (no CORS issues, token never reaches client JS).
// Token-gated: missing/wrong ?token= -> 401. Anyone with the link can view,
// so keep the link private.
// Auto-refreshes every 60s via <meta refresh> — a live view of the queue.
const admin = require('firebase-admin');

let _db = null;
function getDb() {
  if (_db) return _db;
  const { FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY } = process.env;
  if (!FIREBASE_ADMIN_PROJECT_ID || !FIREBASE_ADMIN_CLIENT_EMAIL || !FIREBASE_ADMIN_PRIVATE_KEY) {
    throw new Error('Firebase Admin env vars missing');
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: FIREBASE_ADMIN_CLIENT_EMAIL,
        privateKey: FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }
  _db = admin.firestore();
  return _db;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rel(tsMs, nowMs) {
  if (!tsMs) return 'kabhi nahi';
  const s = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (s < 60) return s + ' sec pehle';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min pehle';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' ghante pehle';
  return Math.floor(h / 24) + ' din pehle';
}

function wstatus(lastSeen, nowMs) {
  if (!lastSeen) return ['gray', 'heartbeat nahi'];
  const s = (nowMs - lastSeen) / 1000;
  if (s < 600) return ['green', 'active'];
  if (s < 3600) return ['yellow', 'sust'];
  return ['red', 'band?'];
}

module.exports = async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const q = Object.fromEntries(u.searchParams.entries());
    if (!process.env.DISPATCH_MAIN_TOKEN || q.token !== process.env.DISPATCH_MAIN_TOKEN) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!DOCTYPE html><html><body style="background:#0f1115;color:#e8eaf0;font-family:system-ui;padding:40px;text-align:center"><h1>401</h1><p>?token= me sahi main token lagao</p></body></html>');
    }

    const db = getDb();
    const nowMs = Date.now();

    const [hbSnap, noticesSnap, logSnap] = await Promise.all([
      db.collection('dispatch_heartbeats').get(),
      db.collection('dispatch_notices').get(),
      db.collection('dispatch_message_log').orderBy('createdAtMs', 'desc').limit(20).get(),
    ]);
    const taskSnaps = {};
    for (const st of ['pending', 'claimed', 'done', 'failed']) {
      taskSnaps[st] = await db.collection('dispatch_tasks').where('status', '==', st).limit(50).get();
    }

    const workers = hbSnap.docs.map((d) => d.data())
      .sort((a, b) => (b.lastSeenMs || 0) - (a.lastSeenMs || 0));
    const tasks = {};
    for (const st of ['pending', 'claimed', 'done', 'failed']) {
      tasks[st] = taskSnaps[st].docs.map((d) => Object.assign({ id: d.id }, d.data()))
        .sort((a, b) => (b.createdAtMs || b.claimedAtMs || 0) - (a.createdAtMs || a.claimedAtMs || 0));
    }
    // Workers with no heartbeat doc but visible via tasks (claimed/done) —
    // show them too so no active worker is invisible on the page.
    const seenNames = new Set(workers.map((w) => w.worker));
    const extra = [];
    const consider = (name, activity) => {
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        extra.push({ worker: name, lastSeenMs: 0, _activity: activity });
      }
    };
    tasks.claimed.forEach((t) => consider(t.claimedBy, 'claimed: ' + (t.title || '')));
    tasks.done.slice(0, 10).forEach((t) => consider(t.claimedBy, 'done: ' + (t.title || '')));
    const allWorkers = workers.concat(extra);
    const notices = noticesSnap.docs.map((d) => Object.assign({ key: d.id }, d.data()));
    const chatter = logSnap.docs.map((d) => Object.assign({ _id: d.id }, d.data()));

    const claimedBy = {};
    tasks.claimed.forEach((t) => { if (t.claimedBy) claimedBy[t.claimedBy] = t.title; });

    const workerCards = allWorkers.map((w) => {
      const [color, label] = wstatus(w.lastSeenMs, nowMs);
      const cur = claimedBy[w.worker] || '';
      const line2 = w._activity
        ? `<div class="sub">aakhri kaam: 🎬 ${esc(String(w._activity).slice(0, 60))}</div>`
        : (cur ? `<div class="sub">🎬 ${esc(String(cur).slice(0, 60))}</div>` : '<div class="sub dim">koi task nahi utha rakha</div>');
      const line1 = w.lastSeenMs
        ? `<div class="sub">${esc(rel(w.lastSeenMs, nowMs))} active</div>`
        : '<div class="sub dim">heartbeat nahi bhej raha — poller check karo</div>';
      return `<div class="card"><div class="wrow"><span class="dot ${color}"></span><b>${esc(w.worker)}</b>`
        + `<span class="tag">${label}</span></div>` + line1 + line2 + '</div>';
    }).join('') || '<div class="card dim">koi worker heartbeat nahi mila</div>';

    const trow = (t) => {
      const who = t.claimedBy || (t.assignTo ? '→ ' + t.assignTo : '');
      const gid = t.groupId ? ' · ' + t.groupId : '';
      return `<div class="trow"><div class="tt">${esc(t.title || '?')}</div><div class="sub">${esc(who)}${esc(gid)}</div></div>`;
    };
    const sec = (title, items) =>
      `<h2>${title} <span class="count">${items.length}</span></h2><div class="sec">`
      + (items.map(trow).join('') || '<div class="dim pad">kuch nahi</div>') + '</div>';

    const noticeHtml = notices.map((n) =>
      `<details class="card"><summary><b>${esc(n.key)}</b> — ${esc(n.title || '')}</summary>`
      + `<div class="ntext">${esc(n.text || '')}</div></details>`).join('')
      || '<div class="card dim">koi notice nahi</div>';

    // WhatsApp-style chat popup data (oldest-first for natural chat order)
    // Per-sender bubble colors: each worker gets its own pastel shade + matching name color
    const SENDER_STYLE = {
      'main':    { bubble: '#D9FDD3', name: '#1F7A3D' },
      'video-1': { bubble: '#E3F2FD', name: '#1565C0' },
      'video-2': { bubble: '#FFF8E1', name: '#E65100' },
      'video-3': { bubble: '#FCE4EC', name: '#C2185B' },
    };
    const FALLBACK_STYLE = [
      { bubble: '#EDE7F6', name: '#5E35B1' },
      { bubble: '#E0F7FA', name: '#00838F' },
      { bubble: '#F1F8E9', name: '#558B2F' },
    ];
    const senderStyle = (n) => {
      if (SENDER_STYLE[n]) return SENDER_STYLE[n];
      let h = 0;
      for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return FALLBACK_STYLE[h % FALLBACK_STYLE.length];
    };
    const chatData = chatter.slice().reverse().map((m) => ({
      id: m._id || '',
      from: m.from || '',
      to: m.to || '',
      text: String(m.text || '').slice(0, 500),
      time: rel(m.createdAtMs, nowMs),
    }));
    const chatIdsJson = JSON.stringify(chatData.map((m) => m.id));
    const bubbles = chatData.map((m) => {
      const out = m.from === 'main';
      const st = senderStyle(m.from);
      return `<div class="msg ${out ? 'out' : 'in'}" style="background:${st.bubble}">`
        + (!out ? `<div class="mname" style="color:${st.name}">${esc(m.from)}</div>` : '')
        + `<div class="mtext">${esc(m.text)}</div>`
        + `<div class="mtime">${esc(m.time)} · → ${esc(m.to)}</div></div>`;
    }).join('') || '<div class="dim pad">abhi koi baat-cheet nahi</div>';

    const chatPopup = `
<button id="chatFab" aria-label="Worker chat kholo">
<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1-.2.3-.6.8-.8 1-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4 0-.5.1-.7l.4-.5c.1-.2.1-.4 0-.5l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.2-.7.3-.9.9-1.1 2.2-.2 3.9a11.6 11.6 0 0 0 4.5 4.2c1.7.8 2.4.9 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2 0-.1-.2-.1-.5-.3z"/></svg>
<span id="chatBadge" class="badge" style="display:none"></span>
</button>
<div id="chatPopup" class="chat-popup" style="display:none">
<div class="chat-header"><div class="chat-avatar"><svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg></div><div class="chat-headtext"><div class="chat-title">Worker Chatter</div><div class="chat-sub">owner-only · live</div></div><button id="chatClose" aria-label="band karo">✕</button></div>
<div id="chatBody" class="chat-body">${bubbles}</div>
<div class="chat-foot">owner-only log</div>
</div>
<script>
(function(){
var fab=document.getElementById('chatFab'),pop=document.getElementById('chatPopup'),
body=document.getElementById('chatBody'),badge=document.getElementById('chatBadge'),
ids=${chatIdsJson};
function open(){pop.style.display='flex';badge.style.display='none';try{localStorage.setItem('dq_chat_seen',ids[0]||'');}catch(e){}location.hash='chat';body.scrollTop=body.scrollHeight;}
function close(){pop.style.display='none';if(location.hash==='#chat'){history.replaceState(null,'',location.pathname+location.search);}}
fab.onclick=function(){pop.style.display==='flex'?close():open();};
document.getElementById('chatClose').onclick=close;
document.addEventListener('click',function(e){if(pop.style.display!=='flex')return;if(pop.contains(e.target)||fab.contains(e.target))return;close();});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&pop.style.display==='flex')close();});
try{
var seen=localStorage.getItem('dq_chat_seen');
if(seen&&ids.length&&ids[0]!==seen){var n=ids.indexOf(seen);n=n===-1?ids.length:n;if(n>0){badge.textContent=n>9?'9+':n;badge.style.display='flex';}}
else if(!seen&&ids.length){localStorage.setItem('dq_chat_seen',ids[0]);}
}catch(e){}
if(location.hash==='#chat'&&ids.length){open();}
})();
<\/script>`;

    const upd = new Date(nowMs).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

    const page = `<!DOCTYPE html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Dispatch Queue — Live Status</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0f1115;color:#e8eaf0;font-family:system-ui,sans-serif;padding:14px;max-width:640px;margin:auto}
h1{font-size:20px;margin:6px 0}h2{font-size:15px;margin:18px 0 8px;color:#9fb2ff}
.card{background:#1a1e27;border-radius:12px;padding:12px;margin:8px 0}
.sec{background:#14171e;border-radius:12px;overflow:hidden}
.trow{padding:10px 12px;border-bottom:1px solid #232833}.trow:last-child{border:none}
.tt{font-size:14px}.sub{font-size:12px;color:#9aa3b2;margin-top:3px}.dim{color:#6b7280}.pad{padding:12px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:8px}
.green{background:#34d399}.yellow{background:#fbbf24}.red{background:#f87171}.gray{background:#6b7280}
.wrow{display:flex;align-items:center;gap:6px}.tag{margin-left:auto;font-size:11px;background:#232833;padding:3px 10px;border-radius:20px;color:#c7cede}
.count{background:#2b3342;color:#c7cede;font-size:12px;padding:2px 10px;border-radius:20px}
.head{display:flex;justify-content:space-between;align-items:baseline}
.meta{font-size:12px;color:#9aa3b2;text-align:right}
details summary{cursor:pointer;font-size:14px}.ntext{font-size:13px;color:#c7cede;white-space:pre-wrap;margin-top:8px}
.note{font-size:12px;color:#8b93a5;background:#14171e;border-radius:12px;padding:12px;margin-top:18px;line-height:1.6}
.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:#34d399;margin-right:6px;animation:bl 2s infinite}
@keyframes bl{50%{opacity:.3}}
#chatFab{position:fixed;right:18px;bottom:18px;width:56px;height:56px;border-radius:50%;background:#00a884;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.45);z-index:50;transition:transform .15s ease,box-shadow .15s ease}
#chatFab:hover{transform:scale(1.06);box-shadow:0 6px 20px rgba(0,0,0,.5)}
#chatFab svg{width:28px;height:28px;fill:#fff}
.badge{position:absolute;top:-4px;right:-4px;min-width:22px;height:22px;border-radius:11px;background:#f87171;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 6px;box-shadow:0 2px 6px rgba(0,0,0,.4)}
.chat-popup{position:fixed;right:18px;bottom:86px;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - 120px));background:#EFE9E1;border-radius:16px;display:none;flex-direction:column;overflow:hidden;z-index:50;box-shadow:0 12px 40px rgba(0,0,0,.35);transform-origin:bottom right;animation:popIn .18s ease-out}
@keyframes popIn{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}
.chat-header{background:#F0F2F5;padding:10px 12px;display:flex;align-items:center;gap:10px}
.chat-avatar{width:38px;height:38px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.chat-avatar svg{width:20px;height:20px;fill:#fff}
.chat-headtext{flex:1;min-width:0}
.chat-title{font-size:15px;font-weight:600;line-height:1.2;color:#111B21}
.chat-sub{font-size:11px;color:#667781;line-height:1.3}
#chatClose{background:none;border:none;color:#54656F;font-size:16px;cursor:pointer;padding:8px;border-radius:50%;line-height:1;transition:background .15s}
#chatClose:hover{background:rgba(0,0,0,.06);color:#111B21}
.chat-body{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px}
.chat-body::-webkit-scrollbar{width:6px}
.chat-body::-webkit-scrollbar-thumb{background:#B9C0C7;border-radius:3px}
.msg{max-width:82%;padding:8px 11px;border-radius:10px;font-size:14px;line-height:1.45;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.15);color:#111B21}
.msg.in{background:#FFFFFF;align-self:flex-start;border-top-left-radius:3px}
.msg.out{background:#D9FDD3;align-self:flex-end;border-top-right-radius:3px}
.mname{font-size:12px;font-weight:700;margin-bottom:3px;letter-spacing:.2px}
.mtext{white-space:pre-wrap}
.mtime{font-size:10px;color:#667781;text-align:right;margin-top:5px}
.chat-foot{font-size:11px;color:#667781;text-align:center;padding:9px;background:#F0F2F5;border-top:1px solid #D1D7DB}
</style></head><body>
<div class="head"><h1><span class="live"></span>📡 Worker Status</h1><div class="meta">${esc(upd)} IST<br>har 60 sec auto-refresh</div></div>
<h2>Workers</h2>${workerCards}
${sec('⏳ Pending tasks', tasks.pending)}
${sec('🔔 Claimed (kaam chal raha)', tasks.claimed)}
${sec('✅ Done (aakhri)', tasks.done.slice(0, 5))}
${sec('❌ Failed (aakhri)', tasks.failed.slice(0, 5))}
<h2>📌 Notice board</h2>${noticeHtml}
${chatPopup}
<div class="note">ℹ️ Ye owner-only live view hai — link me token hai, isliye ye link <b>sirf tumhare paas</b> rakho.<br>
💬 Main inbox ke jawab one-shot hain — wo result-checker chat me pahunchata hai, isliye yahan nahi dikhaye jaate.</div>
</body></html>`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(page);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('status error: ' + e.message);
  }
};
