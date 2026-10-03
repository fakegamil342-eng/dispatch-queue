# Queue storage (GitHub file backend)

This directory is the dispatch queue database. Each task, message, notice,
and heartbeat is a JSON file. The Vercel API (`api/dispatch.js`) reads/writes
these via the GitHub API using `GITHUB_QUEUE_TOKEN`.

Layout:
- `tasks/pending/<id>.json` — tasks waiting to be claimed
- `tasks/claimed/<id>.json` — tasks currently claimed by a worker
- `tasks/done/<id>.json` — completed tasks
- `tasks/failed/<id>.json` — failed/cancelled tasks
- `messages/<id>.json` — worker messages (one-shot delivery)
- `notices/<key>.json` — notice board entries
- `heartbeats/<worker>.json` — last heartbeat per worker

Do not edit these files by hand while the queue is live — use the API.
