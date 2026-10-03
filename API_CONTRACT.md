# Dispatch Queue — API contract

Task queue between the **main Muse account** (dispatcher, never does heavy work itself)
and **worker Muse accounts** (do the heavy work, e.g. video generation).

Base URL: `https://dispatch-queue.vercel.app` (live, 2026-10-01)

Auth: `Authorization: Bearer <token>` on every call.
- Main account → `DISPATCH_MAIN_TOKEN`
- Worker accounts → one of `DISPATCH_WORKER_TOKENS` (comma-separated)

## Endpoints

### POST /api/dispatch?route=tasks — create task (main only)
Body:
```json
{
  "title": "Killing Ledger Ep 12 — full video",
  "type": "video",
  "tag": "video",
  "spec": { "kind": "video", "topic": "...", "...": "everything the worker needs, self-contained" },
  "assignTo": "video-2"
}
```
Optional `assignTo` (worker name): only that worker may claim the task —
any other worker's claim gets 409 `not assigned to you`. Omit for open tasks.
Optional `groupId` (string): groups tasks that belong to one bigger job —
e.g. all scene tasks of one short film share `groupId: "film-chudail-20261001"`,
so main can track "all scenes done?" together.
Response: `{ "ok": true, "taskId": "<id>" }`

### GET /api/dispatch?route=tasks&status=pending — list tasks (main only)
Response: `{ "tasks": [ ... ] }` (oldest first)

### GET /api/dispatch?route=pending&tag=video — oldest pending task (worker only, does NOT claim)
Optional `&worker=<name>`: hides tasks assigned (`assignTo`) to a different worker, so one offline worker's targeted tasks never head-of-line-block the others. Workers should always pass their own name.
Response: `{ "task": { "id": "...", "title": "...", "spec": {...}, ... } }` or `{ "task": null }`

### POST /api/dispatch?route=task&id=<id>&action=claim — claim (worker only)
Body: `{ "worker": "video-1" }`
Response: `{ "ok": true, "task": {...} }` — 409 if already claimed, or 409 `worker busy` if this worker already holds an unfinished claim (one task per worker; claims older than 6h count as stale).

### POST /api/dispatch?route=task&id=<id>&action=result — finish (worker only)
Body:
```json
{ "worker": "video-1", "status": "done", "storageFileId": "...", "storageFileName": "ep12.mp4", "note": "..." }
```
`status` is `done` or `failed`. Response: `{ "ok": true }`

### POST /api/dispatch?route=task&id=<id>&action=cancel — cancel (main only)
Body: `{ "reason": "superseded" }` (optional). Marks a pending/claimed task as failed with note `cancelled by main: <reason>`. Response: `{ "ok": true }`

### GET /api/dispatch?route=task&id=<id> — fetch one task (any valid token)
Response: `{ "task": { "id": "...", "status": "pending|claimed|done|failed", "spec": {...}, "result": {...} } }`

### POST /api/dispatch?route=message — send a message (worker or main)
Direct worker-to-worker messaging through the API. Body:
```json
{ "worker": "video-2", "to": "video-1", "text": "apne scene ka last frame bhejo, continuity match karni hai", "refFileId": "<optional Storage by Iswar fileId>" }
```
- `to`: worker name, or `"all"` for broadcast.
- `refFileId` (optional): share a file via Storage by Iswar (e.g. character reference frame).
- Sender is `body.worker`; main account sends as `"main"` (worker field ignored).
- Max 2000 chars. Response: `{ "ok": true, "messageId": "<id>" }`

### GET /api/dispatch?route=messages&worker=<name> — poll unread messages (worker, or main's own inbox)
Returns unread messages addressed to this worker (`to` = name or `"all"`),
oldest first, max 20. **One-shot delivery:** returned messages are marked
delivered and won't come again.
Response: `{ "messages": [ { "id": "...", "from": "video-2", "to": "video-1", "text": "...", "refFileId": null, "createdAtMs": 0 } ] }`
Workers should poll this on every `dispatch-poller` run, before checking tasks.
- **Main's inbox:** main reads worker replies with `?worker=main` (main only).
  Main may NOT poll as another name (403) — one-shot delivery would steal that
  worker's messages.
- **Two-way Q&A:** main asks a worker via `POST route=message` (`to: "<worker>"`,
  sender is `"main"`); the worker replies with `to: "main"`; main reads the reply
  in its own inbox. Use this when a worker goes silent (stale heartbeat, no
  claim/result) — ask directly instead of guessing.

### POST /api/dispatch?route=notice — publish/update a notice (main only)
Notice board — persistent instructions for workers (messages are one-shot;
notices STAY until main replaces or deletes them). Body:
```json
{ "key": "poller", "title": "Poller prompt v2", "text": "Dispatch queue check karo..." }
```
- `key`: lowercase letters, digits, dash; max 40 chars. Same key = update (upsert).
- `text`: max 5000 chars. Response: `{ "ok": true, "key": "...", "updatedAtMs": 0 }`

### GET /api/dispatch?route=notices — read the notice board (worker or main)
Returns all current notices, oldest first, max 20.
Response: `{ "notices": [ { "key": "...", "title": "...", "text": "...", "updatedAtMs": 0 } ] }`
Workers poll this on every run; when `updatedAtMs` is newer than what they last
saw, they read the notice and update themselves (e.g. update their poller cron).

### DELETE /api/dispatch?route=notice&key=<key> — remove a notice (main only)
Response: `{ "ok": true, "key": "..." }`

### POST /api/dispatch?route=task&id=<id>&action=transfer — hand a claimed task to another worker (worker only)
Body: `{ "worker": "video-1", "to": "video-2", "note": "mera render slow hai" }`
- Task must be claimed by `worker`. Goes back to `pending` with `assignTo: <to>` —
  only the target worker sees/claims it. Target also gets a message about the transfer.
- `400` if `to` missing or self-transfer; `403` if not your claim; `409` if not claimed.
- Response: `{ "ok": true, "to": "video-2" }`

### POST /api/dispatch?route=task&id=<id>&action=rework — send back for rework (main only)
Body: `{ "feedback": "voice robotic hai — natural awaz me dobara banao" }`
- Task must be `done`/`failed`. Goes back to `pending` with `assignTo` = the same worker,
  `reworkCount` +1, `reworkFeedback` set, old result pushed to `prevResults` (max 5 kept).
  Worker also gets the feedback as a message.
- Response: `{ "ok": true, "reworkCount": 1, "assignTo": "video-1" }`

### POST /api/dispatch?route=heartbeat — worker ping (worker only)
Body: `{ "worker": "video-1" }`. Call on every poll. Response: `{ "ok": true, "worker": "...", "lastSeenMs": 0 }`

### GET /api/dispatch?route=heartbeats — who's alive (main only)
Response: `{ "workers": [ { "worker": "video-1", "lastSeenMs": 0 } ] }`, most recent first.

## Task document (Firestore `dispatch_tasks`)
```json
{
  "title": "...", "type": "video", "tag": "video",
  "spec": { "kind": "video", "...": "self-contained instructions" },
  "assignTo": "video-2",
  "groupId": "film-chudail-20261001",
  "status": "pending",
  "createdBy": "main", "createdAtMs": 0, "updatedAtMs": 0,
  "claimedBy": null, "claimedAtMs": null,
  "result": { "status": "done", "storageFileId": "...", "storageFileName": "...", "note": "", "finishedAtMs": 0 }
}
```

## Message document (Firestore `dispatch_messages`)
```json
{
  "from": "video-2", "to": "video-1",
  "text": "...", "refFileId": null,
  "createdAtMs": 0, "deliveredTo": ["video-1"]
}
```

## Notice document (Firestore `dispatch_notices`, doc id = key)
```json
{
  "key": "poller", "title": "Poller prompt v2",
  "text": "...", "updatedAtMs": 0, "updatedBy": "main"
}
```

## Heartbeat document (Firestore `dispatch_heartbeats`, doc id = worker name)
```json
{ "worker": "video-1", "lastSeenMs": 0 }
```

## Transfer / rework fields (on the task document)
- `assignTo`: worker name (transfer target, or rework → same worker)
- `transferredFrom`, `transferNote`, `transferAtMs`
- `reworkCount` (number), `reworkFeedback` (string), `prevResults` (array, max 5)

## Video task spec (example)
```json
{
  "kind": "video",
  "topic": "Villisca axe murders — Part 1",
  "durationSec": 56,
  "aspect": "16:9",
  "characterRefUrl": "https://...",
  "script": "...",
  "styleRules": ["host looks directly into camera", "no burned-in subtitles", "..."],
  "outputName": "killing-ledger-ep12.mp4"
}
```

## Storage handoff (Storage by Iswar)
- Upload: `POST https://ishwar-storage.vercel.app/api/telegram/upload`
  multipart `file` + `uploadedBy`, header `x-user-key: <key>`.
- Download: `GET https://ishwar-storage.vercel.app/api/telegram/download?fileId=<id>`
  with `x-user-key` (fallback: `x-api-key` + `x-project-key` if the account uses those).
