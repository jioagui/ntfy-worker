import { DurableObject } from "cloudflare:workers";

/**
 * ntfy-worker — a tiny, ntfy.sh & ntfy-android compatible publish/subscribe worker
 * powered by Cloudflare Workers + SQLite-backed Durable Objects.
 *
 * Endpoints
 * ---------
 *   POST/PUT /:topic        Publish a message (ntfy headers and/or query params).
 *   POST     /              Publish a message via JSON body ({ topic, message, ... }).
 *   GET      /:topics/auth  Auth check used by ntfy-android (returns { success: true }).
 *   GET      /:topics/ws    Multi-topic WebSocket subscription (Hibernation API).
 *   GET      /:topics/json  NDJSON stream, or one-shot NDJSON when ?poll=1.
 *   GET      /:topics/sse   Server-Sent Events stream (also default for GET /:topics).
 *   GET      /healthz       Liveness check (no auth).
 *   GET      /version       Build version + deploy timestamp (no auth).
 *   GET      /stats         Light service stats (no auth).
 *
 * Auth (fail-closed — returns 503 if NTFY_TOKEN is unset)
 * -------------------------------------------------------
 *   - Authorization: Bearer <NTFY_TOKEN>
 *   - Authorization: Basic <base64(user:NTFY_TOKEN)>  (used by ntfy Android App)
 *   - ?auth=<base64(Basic ... | Bearer ...)>
 */

const VERSION = "2.0.0";
const DEPLOYED_AT = "2026-11-24T00:00:00.000Z";
const MAX_MESSAGES_PER_TOPIC = 200;
const RETENTION_SECONDS = 7 * 24 * 3600;
const KEEPALIVE_INTERVAL_MS = 25_000;
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateId(len = 12) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ID_CHARS[bytes[i] % ID_CHARS.length];
  }
  return out;
}

/** Constant-time UTF-8 string comparison without length early-return. */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const maxLen = Math.max(ab.length, bb.length);
  for (let i = 0; i < maxLen; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function decodeBase64Utf8(input) {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function verifyAuthValue(authHeader, expectedToken) {
  if (!authHeader) return false;
  const trimmed = authHeader.trim();

  const bearerMatch = trimmed.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return timingSafeEqual(bearerMatch[1].trim(), expectedToken);
  }

  const basicMatch = trimmed.match(/^Basic\s+(.+)$/i);
  if (basicMatch) {
    const decoded = decodeBase64Utf8(basicMatch[1].trim());
    if (decoded === null) return false;
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return false;
    const password = decoded.slice(colonIdx + 1);
    return timingSafeEqual(password, expectedToken);
  }

  return false;
}

function unauthorized(reason) {
  return new Response(JSON.stringify({ code: 40100, http: 401, error: reason }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Basic realm="ntfy-worker", charset="UTF-8"',
    },
  });
}

function checkAuth(request, url, env) {
  if (!env.NTFY_TOKEN) {
    return new Response(
      JSON.stringify({
        code: 50300,
        http: 503,
        error: "NTFY_TOKEN secret is not configured on this worker",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const header = request.headers.get("authorization");
  if (header) {
    if (verifyAuthValue(header, env.NTFY_TOKEN)) return null;
    return unauthorized("invalid credentials");
  }

  const queryAuth = url.searchParams.get("auth");
  if (queryAuth) {
    const decoded = decodeBase64Utf8(queryAuth);
    if (decoded && verifyAuthValue(decoded, env.NTFY_TOKEN)) return null;
    if (timingSafeEqual(queryAuth, env.NTFY_TOKEN)) return null;
    return unauthorized("invalid auth query parameter");
  }

  return unauthorized("unauthorized");
}

function readParam(request, url, headerName, queryNames = []) {
  const fromHeader =
    request.headers.get(`X-${headerName}`) ?? request.headers.get(headerName);
  if (fromHeader !== null && fromHeader !== "") return fromHeader;
  for (const q of queryNames) {
    const v = url.searchParams.get(q);
    if (v !== null && v !== "") return v;
  }
  return null;
}

function parsePriority(raw) {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 5) {
    return raw;
  }
  const s = String(raw).trim().toLowerCase();
  const map = {
    "1": 1, min: 1,
    "2": 2, low: 2,
    "3": 3, default: 3,
    "4": 4, high: 4,
    "5": 5, max: 5, urgent: 5,
  };
  return map[s];
}

function parseTags(raw) {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const list = raw.map((t) => String(t).trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  const list = String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function parseTruthy(raw) {
  if (typeof raw === "boolean") return raw;
  if (raw === null || raw === undefined) return false;
  const s = String(raw).trim().toLowerCase();
  return s === "1" || s === "yes" || s === "true";
}

function parseDurationSeconds(str) {
  const m = String(str).trim().match(/^(\d+)([smhd])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}

function parseTopics(segment) {
  if (!segment) return [];
  return Array.from(
    new Set(
      decodeURIComponent(segment)
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= 64),
    ),
  );
}

export class TopicRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.streams = new Set();
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT UNIQUE NOT NULL,
          time INTEGER NOT NULL,
          topic TEXT NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_topic_seq ON messages(topic, seq);
        CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time);
      `);
    });
  }

  saveMessage(msg) {
    const json = JSON.stringify(msg);
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, time, topic, payload) VALUES (?, ?, ?, ?)",
      msg.id,
      msg.time,
      msg.topic,
      json,
    );

    const cutoff = msg.time - RETENTION_SECONDS;
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE time < ?", cutoff);
    this.ctx.storage.sql.exec(
      `DELETE FROM messages
       WHERE topic = ?
         AND seq NOT IN (
           SELECT seq FROM messages WHERE topic = ? ORDER BY seq DESC LIMIT ?
         )`,
      msg.topic,
      msg.topic,
      MAX_MESSAGES_PER_TOPIC,
    );
    return json;
  }

  queryMessages(topics, sinceParam) {
    if (!topics.length) return [];
    const since = (sinceParam ?? "").trim();
    if (!since || since === "none") return [];

    const placeholders = topics.map(() => "?").join(",");

    if (since === "all") {
      return this.ctx.storage.sql
        .exec(
          `SELECT payload FROM messages WHERE topic IN (${placeholders}) ORDER BY seq ASC`,
          ...topics,
        )
        .toArray()
        .map((r) => r.payload);
    }

    if (since === "latest") {
      return this.ctx.storage.sql
        .exec(
          `SELECT payload FROM messages
           WHERE seq IN (
             SELECT MAX(seq) FROM messages WHERE topic IN (${placeholders}) GROUP BY topic
           )
           ORDER BY seq ASC`,
          ...topics,
        )
        .toArray()
        .map((r) => r.payload);
    }

    if (/^\d+$/.test(since)) {
      const ts = Number(since);
      return this.ctx.storage.sql
        .exec(
          `SELECT payload FROM messages WHERE topic IN (${placeholders}) AND time >= ? ORDER BY seq ASC`,
          ...topics,
          ts,
        )
        .toArray()
        .map((r) => r.payload);
    }

    const durSec = parseDurationSeconds(since);
    if (durSec !== null) {
      const cutoff = Math.floor(Date.now() / 1000) - durSec;
      return this.ctx.storage.sql
        .exec(
          `SELECT payload FROM messages WHERE topic IN (${placeholders}) AND time >= ? ORDER BY seq ASC`,
          ...topics,
          cutoff,
        )
        .toArray()
        .map((r) => r.payload);
    }

    const row = this.ctx.storage.sql
      .exec("SELECT seq FROM messages WHERE id = ? LIMIT 1", since)
      .toArray()[0];
    if (row) {
      return this.ctx.storage.sql
        .exec(
          `SELECT payload FROM messages WHERE topic IN (${placeholders}) AND seq > ? ORDER BY seq ASC`,
          ...topics,
          row.seq,
        )
        .toArray()
        .map((r) => r.payload);
    }

    return this.ctx.storage.sql
      .exec(
        `SELECT payload FROM messages WHERE topic IN (${placeholders}) ORDER BY seq ASC`,
        ...topics,
      )
      .toArray()
      .map((r) => r.payload);
  }

  broadcast(topic, payloadJson) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const meta = ws.deserializeAttachment();
        if (meta && Array.isArray(meta.topics) && meta.topics.includes(topic)) {
          ws.send(payloadJson);
        }
      } catch {
        try {
          ws.close(1011, "send failed");
        } catch {}
      }
    }

    for (const stream of this.streams) {
      if (stream.topics.has(topic)) {
        stream.send(payloadJson);
      }
    }
  }

  async webSocketMessage(_ws, _message) {
    // ntfy WebSocket clients are receive-only.
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, "websocket error");
    } catch {}
  }

  async fetch(request) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (request.method === "POST" || request.method === "PUT") {
      return this.handlePublish(request, url, segments);
    }

    const topics = parseTopics(segments[0]);
    if (!topics.length) {
      return new Response(JSON.stringify({ code: 40000, http: 400, error: "missing topic" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const topicsStr = topics.join(",");
    const action = segments[1] || "";

    if (action === "ws") {
      return this.handleWebSocket(request, url, topics, topicsStr);
    }

    if (action === "json") {
      const isPoll = parseTruthy(url.searchParams.get("poll"));
      if (isPoll) {
        const since = url.searchParams.get("since") ?? "all";
        const rows = this.queryMessages(topics, since);
        const body = rows.length ? rows.join("\n") + "\n" : "";
        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      return this.handleLiveStream(request, url, topics, topicsStr, "ndjson");
    }

    return this.handleLiveStream(request, url, topics, topicsStr, "sse");
  }

  async handlePublish(request, url, segments) {
    const now = Math.floor(Date.now() / 1000);
    let msg;

    if (segments.length === 0) {
      let data;
      try {
        data = await request.json();
      } catch {
        return new Response(JSON.stringify({ code: 40001, http: 400, error: "invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const topic = String(data.topic || "").trim();
      if (!topic || topic.length > 64) {
        return new Response(JSON.stringify({ code: 40002, http: 400, error: "invalid topic" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      msg = {
        id: generateId(),
        time: now,
        expires: now + RETENTION_SECONDS,
        event: "message",
        topic,
        message: data.message !== undefined ? String(data.message) : "",
      };
      if (data.title) msg.title = String(data.title);
      const prio = parsePriority(data.priority);
      if (prio !== undefined) msg.priority = prio;
      const tags = parseTags(data.tags);
      if (tags) msg.tags = tags;
      if (data.click) msg.click = String(data.click);
      if (data.icon) msg.icon = String(data.icon);
      if (parseTruthy(data.markdown)) msg.content_type = "text/markdown";
      if (Array.isArray(data.actions) && data.actions.length) msg.actions = data.actions;
      if (data.attach) {
        msg.attachment = {
          name: String(data.filename || "attachment"),
          url: String(data.attach),
        };
      }
    } else {
      const topic = decodeURIComponent(segments[0]).trim();
      if (!topic || topic.length > 64) {
        return new Response(JSON.stringify({ code: 40002, http: 400, error: "invalid topic" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const bodyText = await request.text();
      const queryMessage = url.searchParams.get("message") ?? url.searchParams.get("m");
      const messageText = bodyText !== "" ? bodyText : (queryMessage ?? "triggered");

      msg = {
        id: generateId(),
        time: now,
        expires: now + RETENTION_SECONDS,
        event: "message",
        topic,
        message: messageText,
      };

      const title = readParam(request, url, "Title", ["title", "t"]);
      if (title) msg.title = title;

      const prio = parsePriority(readParam(request, url, "Priority", ["priority", "p"]));
      if (prio !== undefined) msg.priority = prio;

      const tags = parseTags(readParam(request, url, "Tags", ["tags", "tag", "ta"]));
      if (tags) msg.tags = tags;

      const click = readParam(request, url, "Click", ["click"]);
      if (click) msg.click = click;

      const icon = readParam(request, url, "Icon", ["icon"]);
      if (icon) msg.icon = icon;

      if (parseTruthy(readParam(request, url, "Markdown", ["markdown", "md"]))) {
        msg.content_type = "text/markdown";
      }

      const actionsRaw = readParam(request, url, "Actions", ["actions"]);
      if (actionsRaw) {
        try {
          const parsed = JSON.parse(actionsRaw);
          if (Array.isArray(parsed)) msg.actions = parsed;
        } catch {}
      }

      const attachUrl = readParam(request, url, "Attach", ["attach", "a"]);
      if (attachUrl) {
        const filename = readParam(request, url, "Filename", ["filename", "file", "f"]) || "attachment";
        msg.attachment = { name: filename, url: attachUrl };
      }
    }

    const payloadJson = this.saveMessage(msg);
    this.broadcast(msg.topic, payloadJson);

    return new Response(payloadJson, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  handleWebSocket(request, url, topics, topicsStr) {
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics, topicsStr });

    const openEvt = JSON.stringify({
      id: generateId(),
      time: Math.floor(Date.now() / 1000),
      event: "open",
      topic: topicsStr,
    });
    server.send(openEvt);

    const since = url.searchParams.get("since") ?? "none";
    const missed = this.queryMessages(topics, since);
    for (const payload of missed) {
      server.send(payload);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  handleLiveStream(request, url, topics, topicsStr, mode) {
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const format = (jsonStr) => (mode === "sse" ? `data: ${jsonStr}\n\n` : `${jsonStr}\n`);
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      this.streams.delete(entry);
      writer.close().catch(() => {});
    };

    const sendRaw = (jsonStr) => {
      if (closed) return;
      writer.write(encoder.encode(format(jsonStr))).catch(() => cleanup());
    };

    const entry = { topics: new Set(topics), send: sendRaw };
    this.streams.add(entry);

    const timer = setInterval(() => {
      sendRaw(
        JSON.stringify({
          id: generateId(),
          time: Math.floor(Date.now() / 1000),
          event: "keepalive",
          topic: topicsStr,
        }),
      );
    }, KEEPALIVE_INTERVAL_MS);

    request.signal?.addEventListener("abort", cleanup);

    sendRaw(
      JSON.stringify({
        id: generateId(),
        time: Math.floor(Date.now() / 1000),
        event: "open",
        topic: topicsStr,
      }),
    );

    const since = url.searchParams.get("since") ?? "none";
    for (const payload of this.queryMessages(topics, since)) {
      sendRaw(payload);
    }

    return new Response(readable, {
      headers: {
        "content-type":
          mode === "sse"
            ? "text/event-stream; charset=utf-8"
            : "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "ntfy-worker", version: VERSION });
    }
    if (url.pathname === "/version") {
      return Response.json({ version: VERSION, deployedAt: DEPLOYED_AT });
    }
    if (url.pathname === "/stats") {
      return Response.json({
        version: VERSION,
        timestamp: new Date().toISOString(),
      });
    }

    const authFail = checkAuth(request, url, env);
    if (authFail) return authFail;

    const segments = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && segments.length === 2 && segments[1] === "auth") {
      return Response.json({ success: true });
    }

    const id = env.TOPIC_ROOM.idFromName("__hub__");
    const stub = env.TOPIC_ROOM.get(id);
    return stub.fetch(request);
  },
};
