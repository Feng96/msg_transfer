import page from "./page.js";

const roomIdPattern = /^[A-Za-z0-9_-]{16}$/;
const legacyKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const pinPattern = /^[0-9]{6}$/;
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const maxSessionAge = 30 * 24 * 60 * 60;
const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...baseHeaders, ...extraHeaders } });
}
function randomToken(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
async function readJson(request) {
  if (Number(request.headers.get("Content-Length") || 0) > 16000) return null;
  try {
    const raw = await request.text();
    if (raw.length > 16000) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function sameOrigin(request) {
  return request.headers.get("Origin") === new URL(request.url).origin;
}
function cookieValue(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)mt_session=([A-Za-z0-9_-]{43})(?:;|$)/);
  return match?.[1] || null;
}
async function currentSession(request, env) {
  const token = cookieValue(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(tokenHash).first();
  if (!row || row.expires_at <= Date.now()) return null;
  return { token, tokenHash };
}
async function grantRoom(request, env, roomId, existingSession = null) {
  const session = existingSession || await currentSession(request, env);
  const token = session?.token || randomToken(32);
  const tokenHash = session?.tokenHash || await sha256(token);
  const now = Date.now();
  if (session) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(now + maxSessionAge * 1000, tokenHash).run();
  } else {
    await env.DB.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").bind(tokenHash, now, now + maxSessionAge * 1000).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO room_grants (token_hash, room_id) VALUES (?, ?)").bind(tokenHash, roomId).run();
  return `mt_session=${token}; Max-Age=${maxSessionAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
async function hasGrant(env, session, roomId) {
  if (!session) return false;
  const row = await env.DB.prepare("SELECT 1 AS allowed FROM room_grants WHERE token_hash = ? AND room_id = ?").bind(session.tokenHash, roomId).first();
  return Boolean(row);
}
async function consumeLimit(env, key, max, intervalMs) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END, reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END RETURNING count"
  ).bind(key, now + intervalMs, now, now).first();
  return row.count <= max;
}
async function ipTag(request, env) {
  return hmac(env.ROOM_PEPPER, "ip:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
}
function validateMessage(value) {
  const body = typeof value?.body === "string" ? value.body.trim() : "";
  const sender = typeof value?.sender === "string" ? value.sender.trim() : "";
  const clientId = typeof value?.clientId === "string" ? value.clientId.trim() : "";
  if (!body || body.length > 4000 || !sender || sender.length > 20 || !/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  return { body, sender, clientId };
}
function pagination(request) {
  const params = new URL(request.url).searchParams;
  const after = Number(params.get("after") || 0);
  const before = Number(params.get("before") || 0);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(before) || before < 0 || (after && before)) return null;
  return { after, before };
}
async function listMessages(request, env, roomKey) {
  const page = pagination(request);
  if (!page) return json({ error: "查询参数无效" }, 400);
  let result;
  if (page.after) {
    result = await env.DB.prepare("SELECT id, body, sender, client_id, created_at FROM messages WHERE room_hash = ? AND id > ? ORDER BY id ASC LIMIT 101").bind(roomKey, page.after).all();
    return json({ messages: result.results.slice(0, 100), hasMore: result.results.length > 100 });
  }
  if (page.before) {
    result = await env.DB.prepare("SELECT id, body, sender, client_id, created_at FROM messages WHERE room_hash = ? AND id < ? ORDER BY id DESC LIMIT 101").bind(roomKey, page.before).all();
  } else {
    result = await env.DB.prepare("SELECT id, body, sender, client_id, created_at FROM messages WHERE room_hash = ? ORDER BY id DESC LIMIT 101").bind(roomKey).all();
  }
  return json({ messages: result.results.slice(0, 100).reverse(), hasMore: result.results.length > 100 });
}
async function saveMessage(request, env, roomKey, roomId = null) {
  const value = await readJson(request);
  const message = validateMessage(value);
  if (!message) return json({ error: "消息内容或设备名称无效" }, 400);
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE room_hash = ? AND created_at > ?").bind(roomKey, now - 3600000).first();
  if (recent?.count >= 300) return json({ error: "发送太频繁，请稍后再试" }, 429);
  const saved = await env.DB.prepare("INSERT INTO messages (room_hash, body, sender, client_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(roomKey, message.body, message.sender, message.clientId, now).run();
  if (roomId) await env.DB.prepare("UPDATE rooms SET last_message_at = ? WHERE id = ?").bind(now, roomId).run();
  return json({ message: { id: saved.meta.last_row_id, body: message.body, sender: message.sender, client_id: message.clientId, created_at: now } }, 201);
}
async function rooms(request, env) {
  if (request.method === "GET") {
    const session = await currentSession(request, env);
    const result = await env.DB.prepare(
      "SELECT id, name, created_at, last_message_at, EXISTS(SELECT 1 FROM room_grants WHERE token_hash = ? AND room_id = rooms.id) AS unlocked FROM rooms ORDER BY last_message_at DESC, created_at DESC LIMIT 200"
    ).bind(session?.tokenHash || "").all();
    return json({ rooms: result.results.map((room) => ({ ...room, unlocked: Boolean(room.unlocked) })) });
  }
  if (request.method !== "POST") return json({ error: "不支持此操作" }, 405);
  const value = await readJson(request);
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  const pin = value?.pin;
  if (!name || name.length > 40 || typeof pin !== "string" || !pinPattern.test(pin)) return json({ error: "请输入房间名称和 6 位数字密码" }, 400);
  const tag = await ipTag(request, env);
  if (!await consumeLimit(env, "create:" + tag, 5, 24 * 3600000)) return json({ error: "今天创建房间过多，请稍后再试" }, 429);
  const id = randomToken(12);
  const salt = randomToken(16);
  const pinHash = await hmac(env.ROOM_PEPPER, "room-pin:" + salt + ":" + pin);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO rooms (id, name, pin_salt, pin_hash, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, 0)").bind(id, name, salt, pinHash, now).run();
  const cookie = await grantRoom(request, env, id);
  return json({ room: { id, name, created_at: now, last_message_at: 0, unlocked: true } }, 201, { "set-cookie": cookie });
}
async function roomRoute(request, env, roomId, action) {
  if (!roomIdPattern.test(roomId)) return json({ error: "房间不存在" }, 404);
  const room = await env.DB.prepare("SELECT id, name, pin_salt, pin_hash, created_at, last_message_at FROM rooms WHERE id = ?").bind(roomId).first();
  if (!room) return json({ error: "房间不存在" }, 404);
  const session = await currentSession(request, env);
  if (!action && request.method === "GET") {
    return json({ room: { id: room.id, name: room.name, created_at: room.created_at, last_message_at: room.last_message_at, unlocked: await hasGrant(env, session, roomId) } });
  }
  if (action === "unlock" && request.method === "POST") {
    if (await hasGrant(env, session, roomId)) return json({ room: { id: room.id, name: room.name, unlocked: true } });
    const value = await readJson(request);
    const pin = value?.pin;
    if (typeof pin !== "string" || !pinPattern.test(pin)) return json({ error: "请输入 6 位数字密码" }, 400);
    const tag = await ipTag(request, env);
    if (!await consumeLimit(env, "pin-ip:" + roomId + ":" + tag, 5, 15 * 60000)) return json({ error: "尝试次数过多，请 15 分钟后再试" }, 429);
    if (!await consumeLimit(env, "pin-room:" + roomId, 100, 3600000)) return json({ error: "该房间暂时无法验证，请稍后再试" }, 429);
    const calculated = await hmac(env.ROOM_PEPPER, "room-pin:" + room.pin_salt + ":" + pin);
    if (!constantTimeEqual(calculated, room.pin_hash)) return json({ error: "房间密码错误" }, 401);
    const cookie = await grantRoom(request, env, roomId, session);
    return json({ room: { id: room.id, name: room.name, unlocked: true } }, 200, { "set-cookie": cookie });
  }
  if (!await hasGrant(env, session, roomId)) return json({ error: "请先输入房间密码" }, 401);
  const roomKey = "room:" + roomId;
  if (action === "messages") {
    if (request.method === "GET") return listMessages(request, env, roomKey);
    if (request.method === "POST") return saveMessage(request, env, roomKey, roomId);
  }
  if (action === "import-legacy" && request.method === "POST") {
    const value = await readJson(request);
    const key = value?.legacyKey;
    if (typeof key !== "string" || !legacyKeyPattern.test(key)) return json({ error: "旧版链接无效" }, 400);
    const oldHash = await sha256(key);
    const previous = await env.DB.prepare("SELECT 1 AS done FROM legacy_imports WHERE legacy_hash = ? AND room_id = ?").bind(oldHash, roomId).first();
    if (previous) return json({ imported: 0, alreadyImported: true });
    const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE room_hash = ?").bind(oldHash).first();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO legacy_imports (legacy_hash, room_id) VALUES (?, ?)").bind(oldHash, roomId),
      env.DB.prepare("INSERT INTO messages (room_hash, body, sender, client_id, created_at) SELECT ?, body, sender, client_id, created_at FROM messages WHERE room_hash = ? ORDER BY id").bind(roomKey, oldHash),
      env.DB.prepare("UPDATE rooms SET last_message_at = MAX(last_message_at, ?) WHERE id = ?").bind(Date.now(), roomId),
    ]);
    return json({ imported: total?.count || 0, alreadyImported: false });
  }
  return json({ error: "不支持此操作" }, 405);
}
async function legacyRoute(request, env) {
  const key = request.headers.get("X-Room-Key") || "";
  if (!legacyKeyPattern.test(key)) return json({ error: "旧版链接无效" }, 401);
  const hash = await sha256(key);
  if (request.method === "GET") return listMessages(request, env, hash);
  return json({ error: "请将旧历史导入密码房间" }, 405);
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname.startsWith("/api/")) {
        if (!env.DB || !env.ROOM_PEPPER) return json({ error: "服务尚未配置" }, 503);
        if (request.method !== "GET" && !sameOrigin(request)) return json({ error: "跨站请求被拒绝" }, 403);
        if (pathname === "/api/rooms") return await rooms(request, env);
        if (pathname === "/api/legacy/messages") return await legacyRoute(request, env);
        const match = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(unlock|messages|import-legacy))?$/);
        if (match) return await roomRoute(request, env, match[1], match[2] || null);
        return json({ error: "接口不存在" }, 404);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (pathname !== "/") return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        },
      });
    } catch (error) {
      console.error("Request failed", error?.name || "unknown");
      return pathname.startsWith("/api/") ? json({ error: "服务暂时不可用" }, 500) : new Response("Service unavailable", { status: 500 });
    }
  },
};

