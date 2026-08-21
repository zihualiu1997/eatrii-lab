import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function read(relativePath) {
  const path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  return readFile(path, "utf8");
}

test("skill exposes the beverage branch and preserves one-time location-first intake", async () => {
  const skill = await read("skills/eatrii-lab/SKILL.md");
  assert.match(skill, /下午喝啥/);
  assert.match(skill, /coffee near me/i);
  assert.match(skill, /bubble tea/i);
  assert.match(skill, /一次 `ask_question`/);
  assert.ok(skill.indexOf("你现在在哪儿") < skill.indexOf("送过来"));
  assert.match(skill, /下午点奶茶\/咖啡.*外卖/);
  assert.match(skill, /附近喝杯咖啡\/找地方坐会儿.*到店/);
});

test("beverage search matrices, closing rules, and evidence fields are explicit", async () => {
  const protocol = await read("skills/eatrii-lab/references/beverage-protocol.md");
  assert.match(protocol, /3个空间锚点 × 5组 = 15个逻辑查询/);
  assert.match(protocol, /3个空间锚点 × 3组 = 9个逻辑查询/);
  assert.match(protocol, /最多3次.*补查/);
  assert.match(protocol, /基础矩阵完成前不得推荐或排序/);
  assert.match(protocol, /不编造具体饮品/);

  const nearby = await read("skills/eatrii-lab/references/nearby-search-protocol.md");
  assert.match(nearby, /饮料 15\/15/);
  assert.match(nearby, /目标品类 9\/9/);
  assert.match(nearby, /餐饮大类 `050000`/);
});

test("brand dynamics and conversation style cannot override base ranking", async () => {
  const skill = await read("skills/eatrii-lab/SKILL.md");
  const style = await read("skills/eatrii-lab/references/conversation-style.md");
  assert.match(skill, /最多3个品牌/);
  assert.match(skill, /不超过7天可称“这周上新”/);
  assert.match(skill, /8至14天称“最近上新”/);
  assert.match(skill, /超过14天不主动提示/);
  assert.match(skill, /晚于 `review_due_at` 时自动忽略/);
  assert.match(skill, /达美乐不得因周三就宣称固定折扣/);
  assert.match(style, /每次回复最多使用一句轻梗和一个 emoji/);
  assert.match(style, /商务宴请.*零梗/);
  assert.match(style, /不得改变候选池、候选顺序、价格、来源、置信度或未知状态/);
});

test("tool and MCP surfaces remain unchanged", async () => {
  const tools = await read("tools.txt");
  const mcp = JSON.parse(await read(".mcp.json"));
  assert.match(tools, /map-enumerate-nearby/);
  assert.ok(!/brand-news|promotion|beverage/i.test(tools));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["eatrii-amap"]);

  const server = await read("mcp/server.mjs");
  assert.match(server, /const TOOL_NAME = "map-enumerate-nearby"/);
  assert.doesNotMatch(server, /map-enumerate-beverage/);
});
