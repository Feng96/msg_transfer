import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "../dist/server/index.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  const migration = readFileSync(new URL("../drizzle/0000_messages.sql", import.meta.url), "utf8");
  sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async first() { return sqlite.prepare(sql).get(...args); },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    },
  };
}

const url = "https://example.com/api/messages";
const roomA = "A".repeat(43);
const roomB = "B".repeat(43);
const clientId = "12345678-1234-1234-1234-123456789abc";
function request(room, method = "GET", body, path = url) {
  return new Request(path, {
    method,
    headers: { "X-Room-Key": room, ...(body ? { "Content-Type": "application/json", Origin: "https://example.com" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("a shared room stores history and another room cannot read it", async () => {
  const env = { DB: database() };
  const message = { body: "从电脑发送", sender: "我的电脑", clientId };
  const post = await worker.fetch(request(roomA, "POST", message), env);
  assert.equal(post.status, 201);
  const saved = (await post.json()).message;
  assert.equal(saved.body, message.body);
  assert.equal(saved.id, 1);
  const own = await worker.fetch(request(roomA), env);
  assert.deepEqual((await own.json()).messages.map((m) => m.body), ["从电脑发送"]);
  const other = await worker.fetch(request(roomB), env);
  assert.deepEqual((await other.json()).messages, []);
  const newest = await worker.fetch(request(roomA, "GET", null, url + "?after=1"), env);
  assert.deepEqual((await newest.json()).messages, []);
});

test("invalid room and invalid input are rejected", async () => {
  const env = { DB: database() };
  assert.equal((await worker.fetch(request("short"), env)).status, 401);
  assert.equal((await worker.fetch(request(roomA, "POST", { body: "", sender: "设备", clientId }), env)).status, 400);
  const crossOrigin = new Request(url, {
    method: "POST",
    headers: { "X-Room-Key": roomA, "Content-Type": "application/json", Origin: "https://wrong.example" },
    body: JSON.stringify({ body: "test", sender: "设备", clientId }),
  });
  assert.equal((await worker.fetch(crossOrigin, env)).status, 403);
});

