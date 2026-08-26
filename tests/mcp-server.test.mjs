import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const FETCH_ONCE_FIXTURE = new URL("./fixtures/amap-fetch-once.mjs", import.meta.url).href;

function startServer(t, options = {}) {
  const childEnv = { ...process.env };
  const amapKey = options.amapKey === undefined ? "TEST_LIST_ONLY_KEY" : options.amapKey;
  if (amapKey === null) {
    delete childEnv.AMAP_WEB_SERVICE_KEY;
  } else {
    childEnv.AMAP_WEB_SERVICE_KEY = amapKey;
  }
  if (options.minimumIntervalMs !== undefined) {
    childEnv.AMAP_POI_MIN_INTERVAL_MS = String(options.minimumIntervalMs);
  }
  const nodeArgs = options.preloadFixture
    ? ["--import", options.preloadFixture, SERVER_PATH]
    : [SERVER_PATH];
  const child = spawn(process.execPath, nodeArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    windowsHide: true,
  });

  let stdoutBuffer = "";
  let stderr = "";
  const pending = new Map();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const waiter of pending.values()) {
          waiter.reject(new Error(`non-JSON stdout from MCP server: ${line}\n${error.message}`));
        }
        pending.clear();
        continue;
      }

      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    }
  });

  child.on("exit", (code, signal) => {
    if (pending.size === 0) return;
    const error = new Error(
      `MCP server exited before responding (code=${code}, signal=${signal})\n${stderr}`,
    );
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id, method, params = {}) {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}\n${stderr}`));
      }, 5_000);
      timer.unref();

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  t.after(() => {
    child.stdin.end();
    if (!child.killed) child.kill();
  });

  return { request, send };
}

test("MCP server initializes and lists map-enumerate-nearby", async (t) => {
  const session = startServer(t);
  const initialized = await session.request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "eatrii-lab-test", version: "1.0.0" },
  });

  assert.equal(typeof initialized.protocolVersion, "string");
  assert.equal(typeof initialized.serverInfo?.name, "string");
  assert.equal(initialized.serverInfo?.version, "0.3.0");

  session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const listed = await session.request(2, "tools/list");
  const tool = listed.tools.find((candidate) => candidate.name === "map-enumerate-nearby");

  assert.ok(tool, "map-enumerate-nearby was not registered");
  assert.equal(tool.inputSchema?.type, "object");
  assert.equal(tool.inputSchema?.oneOf, undefined);
  assert.ok(tool.inputSchema?.properties?.city_hint);
  assert.ok(tool.inputSchema?.properties?.radius_m);
  assert.ok(tool.inputSchema?.properties?.max_poi_requests);
  assert.ok(tool.inputSchema?.properties?.result_page_size);
  assert.ok(tool.inputSchema?.properties?.next_cursor);
  assert.ok(tool.inputSchema?.properties?.cursor);
  assert.match(tool.inputSchema.properties.cursor.description, /deprecated/i);
});

test("MCP tool reports a missing Amap key without attempting a lookup", async (t) => {
  const session = startServer(t, { amapKey: null });
  await session.request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "eatrii-lab-test", version: "1.0.0" },
  });
  const result = await session.request(2, "tools/call", {
    name: "map-enumerate-nearby",
    arguments: { address: "深圳南山云科技大厦", city_hint: "深圳市" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "AMAP_KEY_MISSING");
  assert.equal(result.structuredContent?.coverage_status, "provider_unavailable");
});

test("MCP next_cursor continuation is paged, idempotent, and does not rescan Amap", async (t) => {
  const session = startServer(t, {
    preloadFixture: FETCH_ONCE_FIXTURE,
    minimumIntervalMs: 0,
  });
  await session.request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "eatrii-lab-test", version: "1.0.0" },
  });

  const first = await session.request(2, "tools/call", {
    name: "map-enumerate-nearby",
    arguments: {
      address: "深圳南山云科技大厦",
      city_hint: "深圳市",
      scene: "dine_in",
      result_page_size: 1,
    },
  });
  const firstPage = first.structuredContent;
  const nextCursor = firstPage.delivery.next_cursor;
  assert.equal(first.isError, false);
  assert.equal(firstPage.delivery.delivery_complete, false);
  assert.equal(firstPage.pois.length, 1);
  assert.equal(firstPage.audit.geocode_requests, 1);
  assert.equal(firstPage.audit.poi_requests_used, 1);
  assert.equal(typeof nextCursor, "string");

  const second = await session.request(3, "tools/call", {
    name: "map-enumerate-nearby",
    arguments: { next_cursor: nextCursor },
  });
  assert.equal(second.isError, false);
  assert.equal(second.structuredContent.delivery.page_offset, 1);
  assert.equal(second.structuredContent.audit.geocode_requests, 1);
  assert.equal(second.structuredContent.audit.poi_requests_used, 1);

  const repeated = await session.request(4, "tools/call", {
    name: "map-enumerate-nearby",
    arguments: { next_cursor: nextCursor },
  });
  assert.deepEqual(repeated.structuredContent, second.structuredContent);

  const legacy = await session.request(5, "tools/call", {
    name: "map-enumerate-nearby",
    arguments: { cursor: nextCursor },
  });
  assert.deepEqual(legacy.structuredContent, second.structuredContent);
});

test("MCP rejects address combined with a cursor instead of rescanning", async (t) => {
  const session = startServer(t, { amapKey: "NOT_USED" });
  await session.request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "eatrii-lab-test", version: "1.0.0" },
  });
  const result = await session.request(2, "tools/call", {
    name: "map-enumerate-nearby",
    arguments: { address: "深圳南山云科技大厦", next_cursor: "opaque" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "INVALID_ARGUMENT");
  assert.match(result.structuredContent.error.message, /address.*游标/);

  const missing = await session.request(3, "tools/call", {
    name: "map-enumerate-nearby",
    arguments: {},
  });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "INVALID_ARGUMENT");
  assert.match(missing.structuredContent.error.message, /address.*next_cursor/);
});
