# Dispatch Queue — deploy guide

Minimal Vercel API (plain Node serverless functions in `/api`, no framework).
State lives in Firestore via Firebase Admin SDK.

## 1) Env vars (Vercel dashboard → Project → Settings → Environment Variables)

| Var | Value |
|---|---|
| `FIREBASE_ADMIN_PROJECT_ID` | Firebase project id (same pattern as other projects) |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Firebase Admin client email |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Firebase Admin private key (`\n` newlines OK) |
| `DISPATCH_MAIN_TOKEN` | random 32-byte hex for the main account |
| `DISPATCH_WORKER_TOKENS` | comma-separated random tokens, one per worker account |

Generate tokens: `openssl rand -hex 32`

## 2) Deploy

1. Push this folder as a repo to GitHub (needs user's yes — push rule).
2. Vercel dashboard → Add New → Project → import the repo. No build settings needed
   (Vercel auto-detects `/api` functions; `npm install` runs from package.json).
3. Add the env vars above, then Deploy.
4. Note the URL: `https://<project>.vercel.app`

## 3) Wire the accounts

- **Main account:** store `DISPATCH_MAIN_TOKEN` in Secure Vault; dispatcher cron
  calls `POST /api/dispatch?route=tasks` and polls `GET /api/dispatch?route=task&id=`.
- **Each worker account:** store its worker token + `ISHWAR_STORAGE_USER_KEY`
  (Storage by Iswar key) in its Secure Vault; poller cron runs:
  `GET /api/dispatch?route=pending&tag=<tag>` → claim → do work →
  upload result to Storage by Iswar → `POST .../task?id=&action=result`.

Firestore needs no composite indexes (single-field `where` on `status` only).
Collection `dispatch_tasks` is created automatically on first write.
