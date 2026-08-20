# Eatrii Lab

Eatrii Lab 是一个本地 Codex 插件，用来决定“现在吃什么”。它包含一个同名 Skill 和只读 MCP 工具 `map-enumerate-nearby`：先通过高德地址解析、餐饮 POI 分页与自适应空间拆分建立平铺候选池，再用网页搜索补漏和核验，最后按到店、外卖或商务宴请场景筛选。

## 这次高德升级解决什么

- 不先取平台榜单或热门店，而是枚举指定半径内的高德餐饮 POI。
- 同一请求到200条时不把第200条当作终点，改用矩形网格继续拆分。
- 结果优先按 POI ID去重，缺少 ID 时才用标准化店名、地址和坐标兜底，并过滤发现半径之外的矩形角落 POI。
- 高德顺序、评分、推广和网页曝光度不参与推荐排序。
- 请求预算耗尽、网格仍饱和、位置歧义或服务失败都会明确降级，不声称“附近全部”。
- 大候选池按游标分页交付；默认每页250家，必须取到 `delivery_complete: true` 才能封池，避免宿主截断后悄悄漏店。

## 前置条件

1. Node.js 20 或更高版本。
2. 高德开放平台的 Web 服务 API Key。
3. 将 Key 配置为环境变量 `AMAP_WEB_SERVICE_KEY`，不要写入仓库或聊天。

Windows PowerShell 可在本机设置用户级环境变量：

```powershell
setx AMAP_WEB_SERVICE_KEY "你的 Web 服务 Key"
```

设置后完全退出并重新打开 Codex，让插件进程读取新环境变量。仓库中的 `.env.example` 只说明变量名；插件不会从仓库文件读取真实 Key。

## 本地验证

```powershell
npm.cmd test
npm.cmd run check:mcp
```

测试全程使用注入的假网络响应，不调用真实高德服务，也不会输出测试 Key。

## 结构

```text
.codex-plugin/plugin.json     插件清单
.mcp.json                     本地 MCP 启动配置
mcp/server.mjs                MCP stdio 入口
mcp/amap-nearby.mjs           高德枚举与空间拆分
mcp/result-pages.mjs          大候选池的短期内存分页
skills/eatrii-lab/            用餐决策 Skill、Persona 与搜索协议
tests/                        离线算法和 MCP 协议测试
```

## 数据与边界

- 位置和 POI 请求会发送到高德 Web 服务；插件只为候选分页在内存中保留结果，默认10分钟，最多8组，不写入磁盘。
- Key 只从进程环境读取，不写入结果、日志或错误文本。
- `amap_enumeration_complete` 只表示本轮高德返回空间已闭合，不代表现实世界门店全量。
- `distance_m` 是 GCJ-02 坐标间的直线距离，不是步行时间、车程或配送范围。
- 插件不会订座、取号、付款或代下单。

第三方佳秀 Persona 的原始文本、来源与 MIT 许可见 `skills/eatrii-lab/references/personas/jiaxiu/`。
