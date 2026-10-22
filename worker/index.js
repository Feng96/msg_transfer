import page from "./page.js";

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const roomPattern = /^[A-Za-z0-9_-]{43}$/;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });

async function getRoomHash(request) {
  const secret = request.headers.get("X-Room-Key") || "";
  if (!roomPattern.test(secret)) return null;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleMessages(request, env) {
  if (!env.DB) return json({ error: "消息存储尚未配置" }, 503);
  const room = await getRoomHash(request);
  if (!room) return json({ error: "房间链接无效" }, 401);
  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const after = Number(params.get("after") || 0);
    const before = Number(params.get("before") || 0);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(before) || before < 0 || (after && before)) {
      return json({ error: "查询参数无效" }, 400);
    }
    let result;
    if (after) {
      result = await env.DB.prepare("SELECT id, body, sender, client_id, created_at FROM messages WHERE room_hash = ? AND id > ? ORDER BY id ASC LIMIT 101").bind(room, after).all();
      return json({ messages: result.results.slice(0, 100), hasMore: result.results.length > 100 });
    }
    if (before) {
      result = await env.DB.prepare("SELECT id, body, sender, client_id, created_at FROM messages WHERE room_hash = ? AND id < ? ORDER BY id DESC LIMIT 101").bind(room, before).all();
    } else {
      result = await env.DB.prepare("SELECT id, body, sender, client_id, created_at FROM messages WHERE room_hash = ? ORDER BY id DESC LIMIT 101").bind(room).all();
    }
    return json({ messages: result.results.slice(0, 100).reverse(), hasMore: result.results.length > 100 });
  }
  if (request.method !== "POST") return json({ error: "不支持此操作" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "跨站请求被拒绝" }, 403);
  if (Number(request.headers.get("Content-Length") || 0) > 16000) return json({ error: "消息过长" }, 413);
  let value;
  try { value = await request.json(); } catch { return json({ error: "消息格式无效" }, 400); }
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const sender = typeof value.sender === "string" ? value.sender.trim() : "";
  const clientId = typeof value.clientId === "string" ? value.clientId.trim() : "";
  if (!body || body.length > 4000 || !sender || sender.length > 20 || !/^[0-9a-f-]{36}$/i.test(clientId)) {
    return json({ error: "消息内容或设备名称无效" }, 400);
  }
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE room_hash = ? AND created_at > ?").bind(room, now - 3600000).first();
  if (recent?.count >= 300) return json({ error: "发送太频繁，请稍后再试" }, 429);
  const saved = await env.DB.prepare("INSERT INTO messages (room_hash, body, sender, client_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(room, body, sender, clientId, now).run();
  return json({ message: { id: saved.meta.last_row_id, body, sender, client_id: clientId, created_at: now } }, 201);
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname === "/api/messages") return await handleMessages(request, env);
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
      console.error("Request failed", error);
      return pathname.startsWith("/api/") ? json({ error: "服务暂时不可用" }, 500) : new Response("Service unavailable", { status: 500 });
    }
  },
};

