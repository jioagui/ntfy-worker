---
name: deploy-ntfy-worker
description: Deploys, updates, verifies, or troubleshoots the Android-compatible ntfy-worker on Cloudflare Workers + SQLite Durable Objects. Covers Cloudflare MCP API and cf CLI deployment, custom domain binding, same-zone Worker-to-Worker integration, ntfy-android protocol pitfalls (Basic Auth, WebSocket Hibernation, HTTP/2 NAT drops, NDJSON polling), and end-to-end verification.
---

# Deploy `ntfy-worker`

End-to-end deployment, integration, and troubleshooting skill for the Android-compatible `ntfy-worker` (Cloudflare Workers + SQLite-backed Durable Objects).

## Pre-Flight Checklist

Confirm only the parameters not already known:

| Parameter | Default / Notes |
| --- | --- |
| Target Cloudflare Account (`<ACCOUNT_ID>`) | Resolve via Cloudflare MCP `GET /accounts` or `cf auth whoami` |
| Worker Name (`<WORKER_NAME>`) | Default `ntfy-worker` |
| Custom Domain (`<CUSTOM_DOMAIN>`) | **Strongly recommended** (e.g. `ntfy.<zone>`); required on networks where `*.workers.dev` is DNS-polluted |
| Bearer/Basic Secret (`NTFY_TOKEN`) | Required; Worker fails closed (`503`) if unset |
| Calling Workers on the same zone? | If another Worker on the same Cloudflare zone will call `ntfy-worker`, it requires `global_fetch_strictly_public` or a Service Binding |

---

## Path A: Zero-Dependency Deployment via Cloudflare MCP / API (Recommended)

Because `src/worker.js` is a zero-dependency ES module, deploying directly via the Cloudflare API avoids installing beta CLI/Vite packages locally.

### 1. First-Time Deploy (with SQLite Durable Object Migration)

Upload `src/worker.js` via `PUT /accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>` (`multipart/form-data`):

- Part `metadata` (`application/json`):
  ```json
  {
    "main_module": "worker.js",
    "compatibility_date": "2025-01-01",
    "observability": { "enabled": true },
    "bindings": [
      {
        "type": "durable_object_namespace",
        "name": "TOPIC_ROOM",
        "class_name": "TopicRoom"
      }
    ],
    "migrations": {
      "new_tag": "v1",
      "new_sqlite_classes": ["TopicRoom"]
    }
  }
  ```
- Part `worker.js` (`application/javascript+module`): exact contents of `src/worker.js`.

### 2. Subsequent Redeploys (Preserve SQLite Data & Secrets)

- **Do NOT re-send `migrations`** once `v1` is applied.
- **Include `"keep_bindings": ["secret_text"]`** in `metadata` so `NTFY_TOKEN` is preserved across code updates.
- Durable Object SQLite data persists across script redeploys as long as `TopicRoom` keeps the same class name.

### 3. Configure `NTFY_TOKEN` Secret

`PUT /accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/secrets`:
```json
{
  "name": "NTFY_TOKEN",
  "type": "secret_text",
  "text": "<32-byte-url-safe-random-token>"
}
```
> **Security Hygiene:** If an agent generated the initial token in chat, advise the user to rotate `NTFY_TOKEN` directly in Cloudflare Dashboard (**Workers & Pages → `<WORKER_NAME>` → Settings → Variables and Secrets**) so the live secret does not remain in conversation logs.

### 4. Expose Endpoint (Custom Domain Strongly Recommended)

- **Custom Domain (recommended):**
  Check existing Worker domains (`GET /accounts/<ACCOUNT_ID>/workers/domains`) and DNS records (`GET /zones/<ZONE_ID>/dns_records?name=<CUSTOM_DOMAIN>`), then attach:
  `PUT /accounts/<ACCOUNT_ID>/workers/domains`
  ```json
  {
    "hostname": "<CUSTOM_DOMAIN>",
    "service": "<WORKER_NAME>",
    "zone_id": "<ZONE_ID>",
    "environment": "production"
  }
  ```
- **`workers.dev` subdomain (optional):**
  `POST /accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/subdomain` with `{ "enabled": true }`.

---

## Path B: Deploy via `cf` CLI

1. Ensure `cloudflare.config.ts` does **not** hardcode another account's `accountId`.
2. Install dependencies and authenticate:
   ```bash
   npm install
   cf auth whoami
   ```
3. Set the secret and deploy:
   ```bash
   cf workers secrets update NTFY_TOKEN --worker ntfy-worker --type secret_text --text "<token>"
   npm run deploy
   ```

---

## Integrating Another Worker on the Same Zone

If another Cloudflare Worker hosted on the **same Cloudflare zone** (for example, an email Worker on `mail.example.com`) sends notifications to `https://ntfy.example.com/`:

- Cloudflare blocks same-zone Worker-to-Worker `fetch()` by default with **Error 1042**.
- **Fix (HTTP fetch):** Add `"global_fetch_strictly_public"` to `compatibility_flags` in the **calling** Worker's Wrangler/CF config and redeploy it:
  ```jsonc
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]
  ```
- **Alternative (zero-hop):** Bind `ntfy-worker` via a Cloudflare **Service Binding** on the calling Worker and call `env.NTFY_SERVICE.fetch(...)`.

---

## End-to-End Verification Checklist

Verify all 6 protocol behaviors against `https://<BASE_HOST>` before handing off:

1. **Health check**: `GET /healthz` → `200` with `{"ok":true,"service":"ntfy-worker","version":"2.0.0"}`.
2. **Fail-closed auth**: `GET /verify_topic/auth` without credentials → `401` with `WWW-Authenticate: Basic`.
3. **Android Basic Auth check**: `GET /verify_topic/auth` with `Authorization: Basic base64("ntfy:<NTFY_TOKEN>")` → `200 {"success":true}`.
4. **Multi-topic WebSocket + live publish**: Connect `wss://<BASE_HOST>/t1,t2/ws?since=none&auth=<base64("Basic ...")>`, confirm immediate `{"event":"open","topic":"t1,t2"}`, then `PUT /t2?title=Test&priority=high&tags=bell,check` with `Authorization: Bearer <NTFY_TOKEN>`, and confirm the WebSocket immediately receives `{"event":"message","topic":"t2","priority":4,"tags":["bell","check"],...}`.
5. **JSON body publish**: `POST /` with `Content-Type: application/json` and `{"topic":"t1","title":"Second","message":"Delta sync","priority":5,"tags":["rocket"]}` → `200`.
6. **NDJSON delta polling**: `GET /t1,t2/json?poll=1&since=<firstMsgId>` with Basic Auth → `200` `application/x-ndjson`, returning **only** the second message (no duplicates).

---

## Known Pitfalls & Lessons Learned

### 1. `*.workers.dev` DNS Pollution / Connection Timeouts (Mainland China)
- **Symptom**: Android app fails to subscribe with `failed to connect to <worker>.<subdom>.workers.dev/2a03:2880:...:face:b00c:... (port 443) ... after 15000ms`.
- **Cause**: `*.workers.dev` is DNS-polluted on China mainland mobile networks (resolving to bogus Facebook IPv6 `face:b00c` addresses).
- **Fix**: Bind a Custom Domain (`ntfy.<your-domain>`). After switching domains, the user **must** add/update the credential under **Settings → Manage users** with the exact new Service URL (no trailing slash), because `ntfy-android` matches saved users strictly by base URL.

### 2. Android `Http2Reader` → `SocketException: Software caused connection abort`
- **Symptom**: Publishing from the Android app succeeds (messages are stored on the server), but the phone does not receive live notifications and shows `java.net.SocketException: Software caused connection abort` inside `okhttp3.internal.http2.Http2Reader.nextFrame`.
- **Cause**: `ntfy-android` defaults to **HTTP/2 JSON streaming** (`GET /:topics/json?since=...`). Mobile carrier NATs (especially 4G/5G NAT with ~30s idle timeouts) and Doze frequently abort long-lived HTTP/2 streams.
- **Fixes & Reality Check**:
  1. Keep `KEEPALIVE_INTERVAL_MS` at **25 seconds** (`25_000`) on the server so HTTP/2 JSON / SSE streams send keepalives before 30s NAT idle cutoffs.
  2. In the Android app, switch **Settings → Connection protocol** to **WebSockets** (`GET /:topics/ws`), which bypasses HTTP/2 streaming and uses Cloudflare's native Durable Objects WebSocket Hibernation (OkHttp's 3-minute Ping frames are answered automatically with Pong without waking the DO).
  3. **Network environment caveat**: On mainland China mobile networks (combined with aggressive OEM background process limits), persistent background connections to Cloudflare Anycast edges can still experience intermittent drops. Pull-to-refresh catch-up via SQLite (`GET /:topics/json?poll=1&since=<lastId>`) remains reliable, whereas users requiring guaranteed zero-background-process instant push inside mainland China should consider domestic push channels (e.g., WeCom / Server酱) or a dedicated push relay.

### 3. `ntfy-android` Wire Protocol Gotchas
- **Basic Auth vs Bearer**: **Settings → Manage users** in `ntfy-android` sends `Authorization: Basic base64(username:password)` (not Bearer). Always validate Basic password against `NTFY_TOKEN` in addition to `Bearer`.
- **`/:topic/auth` endpoint**: `ntfy-android` calls `GET /:topic/auth` before adding a subscription; returning `200 {"success":true}` on valid auth and `401` otherwise is required.
- **NDJSON, not JSON array**: `GET /:topics/json?poll=1` must return newline-delimited JSON (`application/x-ndjson`), one object per line; returning a JSON array `[...]` breaks `NotificationParser.kt`.
- **Single DO Hub for multi-topic**: `ntfy-android` subscribes to all topics on a server over a single comma-separated URL (`/:topic1,topic2/ws` or `/json`). Routing to a single SQLite DO hub (`idFromName("__hub__")`) handles multi-topic WebSockets and cross-topic `since=<id>` polling atomically without fan-out subrequests.
- **Field types**: `priority` must be integer `1..5`, `tags` must be `string[]`, `attachment` must be `{ name, url }` (not a bare string), and markdown uses `content_type: "text/markdown"`.

### 4. Windows / CLI Testing Tips
- On Windows, prefer `curl.exe -4` or Node's built-in `fetch` / `WebSocket` when verifying live endpoints if local IPv6 or Schannel TLS handshakes flake.
- When updating another Wrangler project on Windows PowerShell, use `npx.cmd` / `npm.cmd` and `$env:NODE_OPTIONS="--dns-result-order=ipv4first"`.
