import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));

function startServer(t, options = {}) {
  const childEnv = { ...process.env };
  const amapKey = options.amapKey === undefined ? "TEST_LIST_ONLY_KEY" : options.amapKey;
  if (amapKey === null) {
    delete childEnv.AMAP_WEB_SERVICE_KEY;
  } else {
    childEnv.AMAP_WEB_SERVICE_KEY = amapKey;
  }
  const child = spawn(process.execPath, [SERVER_PATH], {
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
  assert.ok(
    tool.inputSchema?.oneOf?.some((branch) => branch.required?.includes("address")),
  );
  assert.ok(tool.inputSchema?.properties?.city_hint);
  assert.ok(tool.inputSchema?.properties?.radius_m);
  assert.ok(tool.inputSchema?.properties?.max_poi_requests);
  assert.ok(tool.inputSchema?.properties?.result_page_size);
  assert.ok(tool.inputSchema?.properties?.cursor);
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
