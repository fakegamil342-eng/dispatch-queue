// Quick actions from the public status page: send message + create task.
// Proxies to the dispatch API using the server-side main token (never exposed to browser).
const DISPATCH_API = 'https://dispatch-queue.vercel.app/api/dispatch';

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

const PAGE_PIN = process.env.STATUS_PAGE_PIN || '936537';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  try {
    const token = process.env.DISPATCH_MAIN_TOKEN;
    if (!token) throw new Error('DISPATCH_MAIN_TOKEN missing');

    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body || '{}');

    if (data.action === 'verify-pin') {
      return send(res, 200, { ok: String(data.pin || '') === PAGE_PIN });
    }
    if (String(data.pin || '') !== PAGE_PIN) throw new Error('Wrong PIN');

    let url, payload;
    if (data.action === 'send-message') {
      const text = String(data.text || '').trim();
      if (!text) throw new Error('Empty message');
      const to = String(data.to || '').trim() || 'video-1';
      url = DISPATCH_API + '?route=message';
      payload = { to, text: text.slice(0, 2000) };
    } else if (data.action === 'create-task') {
      const title = String(data.title || '').trim();
      if (!title) throw new Error('Empty title');
      url = DISPATCH_API + '?route=tasks';
      payload = {
        title: title.slice(0, 200),
        type: 'general',
        tag: String(data.tag || '').trim() || null,
        spec: { note: String(data.note || '').slice(0, 2000) },
      };
      const assignTo = String(data.assignTo || '').trim();
      if (assignTo && assignTo !== 'any') payload.assignTo = assignTo;
    } else {
      throw new Error('Unknown action');
    }

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(payload),
    });
    const out = await r.json().catch(() => ({}));
    return send(res, r.status, out);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
};
