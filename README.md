# ntfy-worker (Android App Compatible Fork)

A tiny, [ntfy.sh](https://ntfy.sh) & **ntfy Android App** compatible publish/subscribe worker for
Cloudflare Workers + SQLite-backed Durable Objects. Forked from [jonnyparris/ntfy-worker](https://github.com/jonnyparris/ntfy-worker) with full Android client support and persistent storage.

## What's Added in This Fork

- **ntfy Android App compatibility (`ntfy-android`)**:
  - Multi-topic WebSocket subscription (`GET /:topics/ws`) using the **Cloudflare Durable Objects WebSocket Hibernation API** (minimal compute billing while idle).
  - Standard NDJSON polling (`GET /:topics/json?poll=1&since=...`) and NDJSON streaming (`GET /:topics/json?since=...`) with 25s keepalives.
  - Auth check endpoint (`GET /:topic/auth`).
  - `POST /` JSON-body publishing and `PUT /:topic` query-parameter publishing (used by the Android app).
  - Normalized ntfy message schema (`id`, `time`, `expires`, `event`, `topic`, integer `priority` `1-5`, string-array `tags`, `content_type: "text/markdown"`, structured `attachment` & `actions`).
- **SQLite Durable Object persistence**:
  - Stores up to 200 recent messages per topic (7-day retention) in Durable Object SQLite so offline devices catch up cleanly via `?since=<id|all|latest|duration|timestamp>`.
- **Flexible fail-closed auth**:
  - Supports `Authorization: Bearer <NTFY_TOKEN>`, `Authorization: Basic <base64(user:NTFY_TOKEN)>` (for ntfy Android's Manage Users), and `?auth=<base64>`.
  - Constant-time comparison without length early-return; returns `503` if `NTFY_TOKEN` is unset.
- **Portable config & Agent Deployment Skill**:
  - Removed the hardcoded upstream `accountId` from `cloudflare.config.ts`.
  - Bundled [`.agents/skills/deploy-ntfy-worker/SKILL.md`](.agents/skills/deploy-ntfy-worker/SKILL.md) with automated deployment steps and real-world troubleshooting guidance (custom domains, same-zone Worker Error 1042, Android HTTP/2 NAT drops vs WebSockets, etc.).

## Endpoints

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| `POST` / `PUT` | `/:topic` | ✓ | Publish a message (body + ntfy headers and/or query params). |
| `POST` | `/` | ✓ | Publish a message via JSON body (`{ "topic": "...", "message": "...", ... }`). |
| `GET` | `/:topics/auth` | ✓ | Auth check for ntfy clients (`200 { "success": true }`). |
| `GET` | `/:topics/ws` | ✓ | Multi-topic WebSocket stream (`?since=none\|all\|latest\|<id>\|<ts>\|<duration>`). |
| `GET` | `/:topics/json` | ✓ | NDJSON live stream, or one-shot NDJSON when `?poll=1`. |
| `GET` | `/:topics/sse` / `/:topics` | ✓ | Server-Sent Events live stream. |
| `GET` | `/healthz` | — | Liveness check. |
| `GET` | `/version` | — | Build version + deploy timestamp. |
| `GET` | `/stats` | — | Light service stats. |

## Auth

Set `NTFY_TOKEN` before deploying:

```bash
# Generate a strong token
openssl rand -base64 32

# Store it in Cloudflare
cf workers secrets update NTFY_TOKEN --worker ntfy-worker --type secret_text --text "<token>"
```

Clients can authenticate using any of:
- `Authorization: Bearer <NTFY_TOKEN>`
- `Authorization: Basic <base64(any-username:NTFY_TOKEN)>` (used by **ntfy Android App → Settings → Manage users**)
- `?auth=<base64(Basic ... | Bearer ...)>`

## Using with the ntfy Android App

1. Install the official **ntfy** app (Google Play / F-Droid).
2. Open **Settings → Manage users → Add new user**:
   - **Service URL**: `https://<your-ntfy-domain>` (custom domain recommended; avoid `*.workers.dev` on networks with DNS pollution, and omit trailing `/`)
   - **Username**: any string (e.g. `ntfy`)
   - **Password**: your `NTFY_TOKEN`
3. *(Recommended)* Under **Settings → Connection protocol**, select **WebSockets** to avoid mobile carrier NAT drops on HTTP/2 streams and leverage Durable Object WebSocket Hibernation.
4. Subscribe to any topic using your server URL and enable **Instant delivery** if you want background push alerts (or pull down to refresh anytime to catch up via SQLite history).

## Quick Start

```bash
git clone https://github.com/jioagui/ntfy-worker.git
cd ntfy-worker
npm install
cf workers secrets update NTFY_TOKEN --worker ntfy-worker --type secret_text --text "<token>"
npm run deploy
```

> **AI Agent Deployment:** This repo includes a ready-to-use workspace skill at [`.agents/skills/deploy-ntfy-worker/SKILL.md`](.agents/skills/deploy-ntfy-worker/SKILL.md) covering zero-dependency Cloudflare MCP deployment, custom domains, same-zone Worker integration (`global_fetch_strictly_public`), and Android troubleshooting.

### Publish a Message

```bash
TOKEN="..."
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Title: Deployment" \
  -H "X-Priority: high" \
  -H "X-Tags: rocket,white_check_mark" \
  -d "Build succeeded" \
  https://<your-worker-url>/alerts
```

Or via JSON body (`POST /`):

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"topic":"alerts","title":"Deployment","message":"Build succeeded","priority":4,"tags":["rocket"]}' \
  https://<your-worker-url>/
```

### Poll Missed Messages (NDJSON)

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://<your-worker-url>/alerts/json?poll=1&since=all"
```

## License

MIT.
