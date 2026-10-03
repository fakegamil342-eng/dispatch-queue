// Dispatch queue API — GitHub file backend (no Firestore).
// Storage layout in repo Iswardahal142/dispatch-queue:
//   queue/tasks/pending/<taskId>.json
//   queue/tasks/claimed/<taskId>.json
//   queue/tasks/done/<taskId>.json
//   queue/tasks/failed/<taskId>.json
//   queue/messages/<messageId>.json
//   queue/notices/<key>.json
//   queue/heartbeats/<worker>.json
//
// Same API contract as before — workers need no changes.

const GH_API = 'https://api.github.com';
const GH_OWNER = 'Iswardahal142';
const GH_REPO = 'dispatch-queue';
const GH_BRANCH = 'main';

function ghToken() {
  const t = process.env.GITHUB_QUEUE_TOKEN;
  if (!t) throw new Error('GITHUB_QUEUE_TOKEN env var missing');
  return t;
}

async function ghFetch(path, method, body) {
  const res = await fetch(GH_API + path, {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + ghToken(),
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'dispatch-queue',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-json */ }
  return { status: res.status, data };
}

// Read a file from the repo. Returns {exists, sha, content (parsed json or null)}.
async function ghReadFile(repoPath) {
  const { status, data } = await ghFetch(
    `/repos/${GH_OWNER}/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`
  );
  if (status === 404) return { exists: false };
  if (status !== 200) throw new Error(`GitHub read failed ${status}: ${repoPath}`);
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  let parsed = null;
  try { parsed = JSON.parse(content); } catch (e) { parsed = null; }
  return { exists: true, sha: data.sha, content: parsed, raw: content };
}

// Write (create or update) a file. Retries on SHA conflict (409).
async function ghWriteFile(repoPath, obj, message, maxRetries) {
  maxRetries = maxRetries || 3;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const existing = await ghReadFile(repoPath);
    const body = {
      message: message || `queue: update ${repoPath}`,
      content,
      branch: GH_BRANCH,
    };
    if (existing.exists) body.sha = existing.sha;
    const { status, data } = await ghFetch(
      `/repos/${GH_OWNER}/${GH_REPO}/contents/${repoPath}`,
      'PUT',
      body
    );
    if (status === 200 || status === 201) return { ok: true, sha: data.content.sha };
    if ((status === 409 || status === 422) && attempt < maxRetries - 1) continue; // conflict, retry
    throw new Error(`GitHub write failed ${status}: ${repoPath}`);
  }
  throw new Error(`GitHub write conflict retries exhausted: ${repoPath}`);
}

// Delete a file. Returns true if deleted, false if already gone.
async function ghDeleteFile(repoPath, message) {
  const existing = await ghReadFile(repoPath);
  if (!existing.exists) return false;
  const { status } = await ghFetch(
    `/repos/${GH_OWNER}/${GH_REPO}/contents/${repoPath}`,
    'DELETE',
    { message: message || `queue: delete ${repoPath}`, sha: existing.sha, branch: GH_BRANCH }
  );
  if (status === 200) return true;
  if (status === 404 || status === 409 || status === 422) return false;
  throw new Error(`GitHub delete failed ${status}: ${repoPath}`);
}

// List files in a directory. Returns array of {name, path}.
async function ghListDir(dirPath) {
  const { status, data } = await ghFetch(
    `/repos/${GH_OWNER}/${GH_REPO}/contents/${dirPath}?ref=${GH_BRANCH}`
  );
  if (status === 404) return [];
  if (status !== 200) throw new Error(`GitHub list failed ${status}: ${dirPath}`);
  if (!Array.isArray(data)) return [];
  return data.filter((f) => f.type === 'file').map((f) => ({ name: f.name, path: f.path }));
}

// --- Auth (same as before: env tokens) ---
function getRole(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  if (process.env.DISPATCH_MAIN_TOKEN && token === process.env.DISPATCH_MAIN_TOKEN) return 'main';
  const workers = (process.env.DISPATCH_WORKER_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (workers.indexOf(token) !== -1) return 'worker';
  return null;
}

function getQuery(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch (e) { return {}; }
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { resolve({}); }
    });
  });
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// --- Task helpers ---
const TASK_DIRS = ['pending', 'claimed', 'done', 'failed'];

async function findTask(taskId) {
  for (const dir of TASK_DIRS) {
    const r = await ghReadFile(`queue/tasks/${dir}/${taskId}.json`);
    if (r.exists) return { dir, task: r.content, sha: r.sha };
  }
  return null;
}

async function listTasksByStatus(status) {
  const files = await ghListDir(`queue/tasks/${status}`);
  const tasks = [];
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    const r = await ghReadFile(f.path);
    if (r.exists && r.content) tasks.push(r.content);
  }
  return tasks;
}

// Move a task file from one status dir to another (with updated content).
async function moveTask(taskId, fromDir, toDir, updatedTask) {
  await ghWriteFile(`queue/tasks/${toDir}/${taskId}.json`, updatedTask, `queue: task ${taskId} ${fromDir}→${toDir}`);
  await ghDeleteFile(`queue/tasks/${fromDir}/${taskId}.json`, `queue: task ${taskId} moved to ${toDir}`);
}

// --- Route handlers ---

async function handleTasks(req, res, q, body) {
  // main only: create task, list tasks by status
  if (req.method === 'POST') {
    const taskId = newId();
    const now = Date.now();
    const task = {
      id: taskId,
      title: body.title || 'untitled',
      type: body.type || 'general',
      tag: body.tag || null,
      status: 'pending',
      assignTo: body.assignTo || null,
      groupId: body.groupId || null,
      spec: body.spec || {},
      createdAtMs: now,
      updatedAtMs: now,
      claimedBy: null,
      claimedAtMs: null,
      result: null,
      reworkCount: 0,
    };
    await ghWriteFile(`queue/tasks/pending/${taskId}.json`, task, `queue: create task ${taskId}`);
    return send(res, 200, { ok: true, taskId });
  }
  if (req.method === 'GET') {
    const status = (q.status || 'pending').trim();
    if (TASK_DIRS.indexOf(status) === -1) return send(res, 400, { error: 'bad status' });
    const tasks = await listTasksByStatus(status);
    tasks.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    return send(res, 200, { tasks });
  }
  return send(res, 405, { error: 'method not allowed' });
}

async function handlePending(req, res, q) {
  // worker only: oldest pending task visible to this worker (does NOT claim)
  const worker = (q.worker || '').trim();
  const tag = (q.tag || '').trim();
  const tasks = await listTasksByStatus('pending');
  tasks.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
  let task = null;
  for (const t of tasks) {
    // Assigned tasks bypass tag filter (always visible to assigned worker)
    if (t.assignTo && t.assignTo !== worker) continue;
    if (!t.assignTo && tag && t.tag && t.tag !== tag) continue;
    task = t;
    break;
  }
  return send(res, 200, { task });
}

async function handleTask(req, res, q, role, body) {
  const taskId = (q.id || '').trim();
  if (!taskId) return send(res, 400, { error: 'id required' });

  if (req.method === 'GET') {
    const found = await findTask(taskId);
    if (!found) return send(res, 404, { error: 'not found' });
    return send(res, 200, { task: found.task });
  }

  if (req.method === 'POST') {
    const action = (q.action || '').trim();

    if (action === 'claim') {
      const worker = (body.worker || '').trim();
      if (!worker) return send(res, 400, { error: 'worker required' });
      const found = await findTask(taskId);
      if (!found) return send(res, 404, { error: 'not found' });
      if (found.dir !== 'pending') return send(res, 409, { error: 'not pending' });
      const t = found.task;
      if (t.assignTo && t.assignTo !== worker) return send(res, 403, { error: 'assigned to another worker' });
      // One task per worker: check if this worker already holds a claim
      const claimed = await listTasksByStatus('claimed');
      const busy = claimed.find((c) => c.claimedBy === worker && (Date.now() - (c.claimedAtMs || 0)) < 6 * 3600 * 1000);
      if (busy) return send(res, 409, { error: 'worker busy', busyTaskId: busy.id });
      t.status = 'claimed';
      t.claimedBy = worker;
      t.claimedAtMs = Date.now();
      t.updatedAtMs = Date.now();
      await moveTask(taskId, 'pending', 'claimed', t);
      return send(res, 200, { ok: true, task: t });
    }

    if (action === 'result') {
      const worker = (body.worker || '').trim();
      const status = (body.status || '').trim(); // done | failed
      if (!worker || (status !== 'done' && status !== 'failed')) {
        return send(res, 400, { error: 'worker and status done|failed required' });
      }
      const found = await findTask(taskId);
      if (!found) return send(res, 404, { error: 'not found' });
      if (found.dir !== 'claimed') return send(res, 409, { error: 'not claimed' });
      const t = found.task;
      if (t.claimedBy !== worker) return send(res, 403, { error: 'claimed by another worker' });
      t.status = status;
      t.result = {
        storageFileId: body.storageFileId || null,
        storageFileName: body.storageFileName || null,
        note: body.note || null,
        finishedAtMs: Date.now(),
      };
      t.updatedAtMs = Date.now();
      await moveTask(taskId, 'claimed', status, t);
      return send(res, 200, { ok: true });
    }

    if (action === 'cancel') {
      const found = await findTask(taskId);
      if (!found) return send(res, 404, { error: 'not found' });
      const t = found.task;
      t.status = 'failed';
      t.result = { note: 'cancelled by main: ' + (body.reason || 'no reason'), finishedAtMs: Date.now() };
      t.updatedAtMs = Date.now();
      await moveTask(taskId, found.dir, 'failed', t);
      return send(res, 200, { ok: true });
    }

    if (action === 'rework') {
      const found = await findTask(taskId);
      if (!found) return send(res, 404, { error: 'not found' });
      if (found.dir !== 'done' && found.dir !== 'failed') return send(res, 409, { error: 'only done/failed can be reworked' });
      const t = found.task;
      t.status = 'pending';
      t.reworkCount = (t.reworkCount || 0) + 1;
      t.feedback = body.feedback || null;
      t.claimedBy = null;
      t.claimedAtMs = null;
      t.result = null;
      t.updatedAtMs = Date.now();
      await moveTask(taskId, found.dir, 'pending', t);
      // Notify worker via message
      if (t.claimedBy || body.notifyWorker) {
        const to = body.notifyWorker || t.assignTo;
        if (to) {
          const msgId = newId();
          await ghWriteFile(`queue/messages/${msgId}.json`, {
            id: msgId, from: 'main', to,
            text: `Rework requested on "${t.title}": ${t.feedback || 'see task'}`,
            createdAtMs: Date.now(), deliveredTo: [],
          }, `queue: rework notice ${msgId}`);
        }
      }
      return send(res, 200, { ok: true });
    }

    if (action === 'transfer') {
      const worker = (body.worker || '').trim();
      const to = (body.to || '').trim();
      if (!worker || !to) return send(res, 400, { error: 'worker and to required' });
      if (worker === to) return send(res, 400, { error: 'cannot transfer to self' });
      const found = await findTask(taskId);
      if (!found) return send(res, 404, { error: 'not found' });
      if (found.dir !== 'claimed') return send(res, 409, { error: 'not claimed' });
      const t = found.task;
      if (t.claimedBy !== worker) return send(res, 403, { error: 'claimed by another worker' });
      t.status = 'pending';
      t.assignTo = to;
      t.claimedBy = null;
      t.claimedAtMs = null;
      t.transferNote = body.note || null;
      t.updatedAtMs = Date.now();
      await moveTask(taskId, 'claimed', 'pending', t);
      const msgId = newId();
      await ghWriteFile(`queue/messages/${msgId}.json`, {
        id: msgId, from: 'main', to,
        text: `Task transferred to you: "${t.title}"${t.transferNote ? ' — ' + t.transferNote : ''}`,
        createdAtMs: Date.now(), deliveredTo: [],
      }, `queue: transfer notice ${msgId}`);
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { error: 'unknown action' });
  }

  return send(res, 405, { error: 'method not allowed' });
}

async function handleMessage(req, res, q, role, body) {
  if (req.method === 'POST') {
    const from = role === 'main' ? 'main' : (body.worker || '').trim();
    const to = (body.to || '').trim();
    const text = (body.text || '').trim();
    if (!from) return send(res, 400, { error: 'worker (sender name) required' });
    if (!to) return send(res, 400, { error: 'to required' });
    if (!text) return send(res, 400, { error: 'text required' });
    if (text.length > 2000) return send(res, 400, { error: 'text too long (max 2000)' });
    const msgId = newId();
    const msg = {
      id: msgId, from, to, text,
      refFileId: body.refFileId || null,
      createdAtMs: Date.now(),
      deliveredTo: [],
    };
    await ghWriteFile(`queue/messages/${msgId}.json`, msg, `queue: message ${msgId}`);
    return send(res, 200, { ok: true, messageId: msgId });
  }

  if (req.method === 'GET') {
    const worker = (q.worker || '').trim();
    if (!worker) return send(res, 400, { error: 'worker query param required' });
    const files = await ghListDir('queue/messages');
    const unread = [];
    for (const f of files) {
      if (!f.name.endsWith('.json')) continue;
      const r = await ghReadFile(f.path);
      if (!r.exists || !r.content) continue;
      const m = r.content;
      const delivered = m.deliveredTo || [];
      if ((m.to === worker || m.to === 'all') && delivered.indexOf(worker) === -1) {
        unread.push({ path: f.path, sha: r.sha, m });
      }
    }
    unread.sort((a, b) => (a.m.createdAtMs || 0) - (b.m.createdAtMs || 0));
    const out = unread.slice(0, 20);
    // Mark as delivered (best-effort, one-shot)
    for (const { path, m } of out) {
      m.deliveredTo = (m.deliveredTo || []).concat([worker]);
      try {
        await ghWriteFile(path, m, `queue: delivered ${m.id} to ${worker}`);
      } catch (e) { /* best-effort */ }
    }
    // Cleanup: delete messages delivered to all intended recipients and older than 1h
    // (keeps the directory from growing unboundedly)
    return send(res, 200, {
      messages: out.map(({ m }) => ({
        id: m.id, from: m.from, to: m.to, text: m.text,
        refFileId: m.refFileId || null, createdAtMs: m.createdAtMs,
      })),
    });
  }

  return send(res, 405, { error: 'method not allowed' });
}

async function handleMessageLog(req, res) {
  // main only: recent messages for observability
  const files = await ghListDir('queue/messages');
  const msgs = [];
  for (const f of files.slice(-50)) {
    if (!f.name.endsWith('.json')) continue;
    const r = await ghReadFile(f.path);
    if (r.exists && r.content) msgs.push(r.content);
  }
  msgs.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return send(res, 200, {
    messages: msgs.slice(0, 50).map((m) => ({
      id: m.id, from: m.from, to: m.to, text: m.text,
      refFileId: m.refFileId || null, createdAtMs: m.createdAtMs,
    })),
  });
}

async function handleNotice(req, res, q, role, body) {
  if (req.method === 'POST') {
    const key = (body.key || '').trim();
    if (!key) return send(res, 400, { error: 'key required' });
    const notice = {
      key,
      title: body.title || key,
      text: body.text || '',
      updatedAtMs: Date.now(),
    };
    await ghWriteFile(`queue/notices/${key}.json`, notice, `queue: notice ${key}`);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && q.key) {
    const r = await ghReadFile(`queue/notices/${q.key}.json`);
    if (!r.exists) return send(res, 404, { error: 'not found' });
    return send(res, 200, { notice: r.content });
  }
  if (req.method === 'DELETE') {
    const key = (q.key || '').trim();
    if (!key) return send(res, 400, { error: 'key required' });
    await ghDeleteFile(`queue/notices/${key}.json`, `queue: delete notice ${key}`);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'method not allowed' });
}

async function handleNotices(req, res) {
  const files = await ghListDir('queue/notices');
  const notices = [];
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    const r = await ghReadFile(f.path);
    if (r.exists && r.content) notices.push(r.content);
  }
  notices.sort((a, b) => (a.key || '').localeCompare(b.key || ''));
  return send(res, 200, { notices });
}

async function handleHeartbeat(req, res, body) {
  const worker = (body.worker || '').trim();
  if (!worker) return send(res, 400, { error: 'worker required' });
  await ghWriteFile(`queue/heartbeats/${worker}.json`, {
    worker, timestampMs: Date.now(),
  }, `queue: heartbeat ${worker}`);
  return send(res, 200, { ok: true });
}

async function handleHeartbeats(req, res) {
  const files = await ghListDir('queue/heartbeats');
  const beats = [];
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    const r = await ghReadFile(f.path);
    if (r.exists && r.content) beats.push(r.content);
  }
  beats.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
  return send(res, 200, { heartbeats: beats });
}

module.exports = async (req, res) => {
  try {
    const role = getRole(req);
    if (!role) return send(res, 401, { error: 'unauthorized' });
    const q = getQuery(req);
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (q.route === 'tasks') {
      if (role !== 'main') return send(res, 403, { error: 'main only' });
      return handleTasks(req, res, q, body);
    }
    if (q.route === 'pending') {
      if (role !== 'worker') return send(res, 403, { error: 'workers only' });
      return handlePending(req, res, q);
    }
    if (q.route === 'task') {
      if (req.method === 'POST' && (q.action === 'cancel' || q.action === 'rework') && role !== 'main') {
        return send(res, 403, { error: 'main only' });
      }
      if (req.method === 'POST' && q.action !== 'cancel' && q.action !== 'rework' && role !== 'worker') {
        return send(res, 403, { error: 'workers only' });
      }
      return handleTask(req, res, q, role, body);
    }
    if (q.route === 'message') {
      return handleMessage(req, res, q, role, body);
    }
    if (q.route === 'messages') {
      return handleMessage(req, res, q, role, body);
    }
    if (q.route === 'messageLog') {
      if (role !== 'main') return send(res, 403, { error: 'main only' });
      return handleMessageLog(req, res);
    }
    if (q.route === 'notice') {
      if (role !== 'main') return send(res, 403, { error: 'main only' });
      return handleNotice(req, res, q, role, body);
    }
    if (q.route === 'notices') {
      return handleNotices(req, res);
    }
    if (q.route === 'heartbeat') {
      if (role !== 'worker') return send(res, 403, { error: 'workers only' });
      return handleHeartbeat(req, res, body);
    }
    if (q.route === 'heartbeats') {
      if (role !== 'main') return send(res, 403, { error: 'main only' });
      return handleHeartbeats(req, res);
    }
    return send(res, 400, { error: 'unknown route' });
  } catch (err) {
    console.error('dispatch error:', err.message);
    return send(res, 500, { error: 'server error', detail: err.message });
  }
};
