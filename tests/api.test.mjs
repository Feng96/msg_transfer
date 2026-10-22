import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "../dist/server/index.js";

const origin = "https://example.com";
const clientId = "12345678-1234-1234-1234-123456789abc";
function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0000_messages.sql", "0001_rooms.sql", "0002_room_access.sql"]) {
    const migration = readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8");
    sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  }
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async first() { return sqlite.prepare(sql).get(...args); },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
        },
        get sql() { return sql; },
        get args() { return args; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => sqlite.prepare(statement.sql).run(...statement.args));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, DB };
}
function request(path, { method = "GET", body, cookie, ip = "192.0.2.1", headers = {} } = {}) {
  return new Request(origin + path, {
    method,
    headers: {
      "CF-Connecting-IP": ip,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function setup() {
  const { sqlite, DB } = makeDb();
  return { sqlite, DB, ROOM_PEPPER: "test-secret-is-not-a-production-secret" };
}
async function create(env, pin = "123456") {
  const response = await worker.fetch(request("/api/rooms", { method: "POST", body: { name: "我的传输助手", pin, deviceName: "电脑" } }), env);
  assert.equal(response.status, 201);
  return { room: (await response.json()).room, cookie: response.headers.get("set-cookie").split(";")[0] };
}

test("PIN is stored only as a keyed hash; room messages require a valid session", async () => {
  const env = await setup();
  const { room, cookie } = await create(env);
  const stored = env.sqlite.prepare("SELECT pin_salt, pin_hash FROM rooms WHERE id = ?").get(room.id);
  assert.ok(stored.pin_salt);
  assert.equal(stored.pin_hash.length, 64);
  assert.notEqual(stored.pin_hash, "123456");
  const publicList = await worker.fetch(request("/api/rooms"), env);
  const listed = (await publicList.json()).rooms[0];
  assert.equal(listed.unlocked, false);
  assert.equal("pin_hash" in listed, false);
  assert.equal("pin_salt" in listed, false);
  assert.equal((await worker.fetch(request("/api/rooms/" + room.id + "/messages"), env)).status, 401);
  const sent = await worker.fetch(request("/api/rooms/" + room.id + "/messages", {
    method: "POST", cookie, body: { body: "跨设备消息", sender: "我的电脑", clientId },
  }), env);
  assert.equal(sent.status, 201);
  const wrong = await worker.fetch(request("/api/rooms/" + room.id + "/unlock", { method: "POST", ip: "192.0.2.2", body: { pin: "000000" } }), env);
  assert.equal(wrong.status, 401);
  const unlocked = await worker.fetch(request("/api/rooms/" + room.id + "/unlock", { method: "POST", ip: "192.0.2.2", body: { pin: "123456" } }), env);
  assert.equal(unlocked.status, 200);
  assert.match(unlocked.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const secondCookie = unlocked.headers.get("set-cookie").split(";")[0];
  const read = await worker.fetch(request("/api/rooms/" + room.id + "/messages", { cookie: secondCookie }), env);
  assert.deepEqual((await read.json()).messages.map((message) => message.body), ["跨设备消息"]);
});

test("room access history and password change revoke other devices without exposing secrets", async () => {
  const env = await setup();
  const { room, cookie } = await create(env);
  const path = "/api/rooms/" + room.id;
  const joined = await worker.fetch(request(path + "/unlock", { method: "POST", ip: "192.0.2.22", body: { pin: "123456", deviceName: "手机" } }), env);
  assert.equal(joined.status, 200);
  const phoneCookie = joined.headers.get("set-cookie").split(";")[0];
  const access = await worker.fetch(request(path + "/access", { cookie }), env);
  assert.equal(access.status, 200);
  const before = await access.json();
  assert.deepEqual(before.devices.map((item) => item.deviceName).sort(), ["手机", "电脑"]);
  assert.equal(before.events.length, 2);
  assert.equal(JSON.stringify(before).includes("123456"), false);
  assert.equal(JSON.stringify(before).includes("token_hash"), false);
  assert.equal((await worker.fetch(request(path + "/access"), env)).status, 401);
  const wrong = await worker.fetch(request(path + "/change-pin", { method: "POST", cookie, body: { oldPin: "000000", newPin: "654321" } }), env);
  assert.equal(wrong.status, 401);
  const changed = await worker.fetch(request(path + "/change-pin", { method: "POST", cookie, body: { oldPin: "123456", newPin: "654321" } }), env);
  assert.equal(changed.status, 200);
  assert.equal((await worker.fetch(request(path + "/messages", { cookie: phoneCookie }), env)).status, 401);
  assert.equal((await worker.fetch(request(path + "/messages", { cookie }), env)).status, 200);
  const after = await (await worker.fetch(request(path + "/access", { cookie }), env)).json();
  assert.equal(after.devices.length, 1);
  assert.equal(after.events[0].type, "password_changed");
  const oldPin = await worker.fetch(request(path + "/unlock", { method: "POST", ip: "192.0.2.23", body: { pin: "123456" } }), env);
  assert.equal(oldPin.status, 401);
  const newPin = await worker.fetch(request(path + "/unlock", { method: "POST", ip: "192.0.2.23", body: { pin: "654321", deviceName: "手机" } }), env);
  assert.equal(newPin.status, 200);
  const renamed = await worker.fetch(request(path + "/device-name", { method: "POST", cookie, body: { deviceName: "家里的电脑" } }), env);
  assert.equal(renamed.status, 200);
  const named = await (await worker.fetch(request(path + "/access", { cookie }), env)).json();
  assert.ok(named.devices.some((item) => item.current && item.deviceName === "家里的电脑"));
});

test("wrong PIN attempts are rate limited and legacy history can be imported once", async () => {
  const env = await setup();
  const { room, cookie } = await create(env);
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await worker.fetch(request("/api/rooms/" + room.id + "/unlock", { method: "POST", ip: "192.0.2.3", body: { pin: "000000" } }), env);
    assert.equal(result.status, 401);
  }
  const blocked = await worker.fetch(request("/api/rooms/" + room.id + "/unlock", { method: "POST", ip: "192.0.2.3", body: { pin: "123456" } }), env);
  assert.equal(blocked.status, 429);
  const legacyKey = "A".repeat(43);
  const legacyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacyKey));
  const hash = [...new Uint8Array(legacyHash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  env.sqlite.prepare("INSERT INTO messages (room_hash, body, sender, client_id, created_at) VALUES (?, ?, ?, ?, ?)").run(hash, "旧版消息", "旧设备", clientId, Date.now());
  const importRequest = () => request("/api/rooms/" + room.id + "/import-legacy", { method: "POST", cookie, body: { legacyKey } });
  const imported = await worker.fetch(importRequest(), env);
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).imported, 1);
  const repeated = await worker.fetch(importRequest(), env);
  assert.equal((await repeated.json()).alreadyImported, true);
  const read = await worker.fetch(request("/api/rooms/" + room.id + "/messages", { cookie }), env);
  assert.deepEqual((await read.json()).messages.map((message) => message.body), ["旧版消息"]);
});

