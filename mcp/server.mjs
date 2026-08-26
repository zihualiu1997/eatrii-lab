import readline from "node:readline";
import {
  AmapToolError,
  enumerateNearby,
  serializeAmapError,
} from "./amap-nearby.mjs";
import {
  createResultPager,
  ResultCursorError,
} from "./result-pages.mjs";

const SERVER_NAME = "Eatrii Amap POI";
const SERVER_VERSION = "0.3.0";
const TOOL_NAME = "map-enumerate-nearby";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2024-11-05",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const resultPager = createResultPager();
const JsonRpcError = Object.freeze({
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolDefinition() {
  return {
    name: TOOL_NAME,
    title: "Enumerate Nearby Dining POIs",
    description:
      "Geocode a specific address with Amap, then enumerate dining POIs inside a radius using pagination and adaptive spatial splitting. Use this as Eatrii's flat discovery layer before web gap searches or recommendation ranking.",
    inputSchema: {
      type: "object",
      description:
        "First scan: pass address (plus optional city_hint and scene). Continuation: pass only next_cursor from delivery.next_cursor. The legacy cursor alias is deprecated.",
      properties: {
        address: {
          type: "string",
          minLength: 1,
          description: "Specific building, park, street address, or delivery address.",
        },
        city_hint: {
          type: "string",
          minLength: 1,
          description: "City hint used to disambiguate the address, such as 深圳市.",
        },
        scene: {
          type: "string",
          enum: ["dine_in", "delivery", "business_casual", "business_formal"],
          default: "dine_in",
          description:
            "Dining scene. Defaults use 1500m for dine-in, 3000m for delivery or casual business, and 5000m for formal business.",
        },
        radius_m: {
          type: "integer",
          minimum: 100,
          maximum: 10000,
          description: "Optional discovery radius override in meters.",
        },
        max_poi_requests: {
          type: "integer",
          minimum: 1,
          maximum: 256,
          description:
            "Optional Amap POI request budget. Geocoding is counted separately; retries consume this budget.",
        },
        result_page_size: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 250,
          description:
            "Maximum POIs returned in one tool response. Continue with next_cursor until delivery_complete is true.",
        },
        next_cursor: {
          type: "string",
          minLength: 1,
          description:
            "Canonical continuation input. Pass the preceding response's delivery.next_cursor by itself; this reads the next in-memory page without geocoding or calling Amap.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          description:
            "Deprecated alias for next_cursor. Prefer next_cursor from delivery.next_cursor.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

function resolveInvocation(args) {
  const hasAddress = Object.hasOwn(args, "address");
  const hasNextCursor = Object.hasOwn(args, "next_cursor");
  const hasLegacyCursor = Object.hasOwn(args, "cursor");

  if (hasNextCursor && hasLegacyCursor) {
    throw new AmapToolError(
      "INVALID_ARGUMENT",
      "next_cursor 与已弃用的 cursor 不能同时传入。",
      { coverage_status: "partial" },
    );
  }
  if (hasAddress && (hasNextCursor || hasLegacyCursor)) {
    throw new AmapToolError(
      "INVALID_ARGUMENT",
      "address 与分页游标不能同时传入；首次扫描只传 address，续页只传 next_cursor。",
      { coverage_status: "partial" },
    );
  }

  const pageCursor = args.next_cursor ?? args.cursor;
  if (hasNextCursor || hasLegacyCursor) {
    if (typeof pageCursor !== "string" || pageCursor.trim().length === 0) {
      throw new AmapToolError(
        "INVALID_ARGUMENT",
        "next_cursor 必须是非空字符串。",
        { coverage_status: "partial" },
      );
    }
    return { mode: "continuation", pageCursor };
  }
  if (!hasAddress) {
    throw new AmapToolError(
      "INVALID_ARGUMENT",
      "首次扫描必须传 address；续页必须传 next_cursor（旧 cursor 仍暂时兼容）。",
      { coverage_status: "partial" },
    );
  }
  return { mode: "first" };
}

async function handleToolCall(id, params) {
  if (params?.name !== TOOL_NAME) {
    sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${params?.name ?? ""}`);
    return;
  }

  try {
    const args = params.arguments ?? {};
    const invocation = resolveInvocation(args);
    const result = invocation.mode === "continuation"
      ? resultPager.nextPage(invocation.pageCursor)
      : resultPager.firstPage(
          await enumerateNearby(args),
          args.result_page_size,
        );
    const candidateCount = result.audit?.candidate_count_inside_radius ?? 0;
    const delivery = result.delivery;
    const deliverySuffix = delivery?.delivery_complete === false
      ? "请继续使用 next_cursor 读取剩余候选。"
      : "候选已完整交付。";
    const text = result.coverage_status === "location_unresolved"
      ? "高德没有把位置唯一解析出来；请让用户补充城市、区或更具体的建筑/门牌信息。"
      : result.coverage_status === "amap_enumeration_complete"
        ? `本轮高德枚举已闭合，半径内检索到 ${candidateCount} 家；这不代表现实门店全量。${deliverySuffix}`
        : `本轮高德枚举未闭合，当前检索到 ${candidateCount} 家；请保留 partial 状态并继续网页补漏。${deliverySuffix}`;
    sendResult(id, {
      content: [{ type: "text", text }],
      structuredContent: result,
      isError: false,
    });
  } catch (error) {
    const safe = error instanceof ResultCursorError
      ? {
          code: error.code,
          message: error.message,
          coverage_status: "partial",
        }
      : serializeAmapError(error);
    sendResult(id, {
      content: [{ type: "text", text: safe.message }],
      structuredContent: {
        status: "error",
        coverage_status: safe.coverage_status,
        provider: "amap",
        error: safe,
      },
      isError: true,
    });
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requestedVersion = params?.protocolVersion;
    sendResult(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Use map-enumerate-nearby only after the user provides a specific location. Treat its order as discovery evidence, never as recommendation ranking. Continue next_cursor pages until delivery_complete is true before closing the candidate pool. A closed Amap enumeration still does not prove real-world completeness.",
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: [toolDefinition()] });
    return;
  }

  if (method === "tools/call") {
    await handleToolCall(id, params);
    return;
  }

  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  void handleRequest(message);
});
