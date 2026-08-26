# Eatrii Lab

Eatrii Lab 是一个本地 Codex 插件，用来决定“现在吃什么或喝什么”。它包含一个同名 Skill 和只读 MCP 工具 `map-enumerate-nearby`：先通过高德地址解析、餐饮 POI 分页与自适应空间拆分建立平铺候选池，再用网页搜索补漏和核验，最后按到店、外卖、自取或商务宴请场景筛选。

## 这次高德升级解决什么

- 不先取平台榜单或热门店，而是枚举指定半径内的高德餐饮 POI。
- 同一请求到200条时不把第200条当作终点，改用矩形网格继续拆分。
- 结果优先按 POI ID去重，缺少 ID 时才用标准化店名、地址和坐标兜底，并过滤发现半径之外的矩形角落 POI。
- 高德顺序、评分、推广和网页曝光度不参与推荐排序。
- 请求预算耗尽、网格仍饱和、位置歧义或服务失败都会明确降级，不声称“附近全部”。
- 大候选池按游标分页交付；默认每页250家，必须取到 `delivery_complete: true` 才能封池，避免宿主截断后悄悄漏店。
- POI 请求在插件进程内共享节流门控，默认 1 QPS；重试与初次请求都计入 `poi_requests_used`，审计另行区分 logical requests 与 attempts。

## 饮料与品牌信息

- 奶茶、咖啡、果茶和下午茶继续使用高德餐饮大类 `050000` 平铺召回；插件没有新增 MCP 工具或改动现有接口。
- 模糊饮料需求执行15格网页补漏；明确只要咖啡或奶茶时执行9格目标品类补漏，候选封池前不按连锁、优惠或热度筛店。
- `brand-signals.json` 只保存有当前官方周期说明、且另有至少90天历史证据的长期活动线索；不保存浮动商品、价格、库存或门店范围。
- 固定活动超过复核日期会自动停止提示。当天官方点单渠道未确认时，活动不能计入实付价格或排序。
- 品牌新品只在候选相关时临时核验最多3个品牌，不写回知识库，也不把品牌全国发布当作附近分店有售。

## 前置条件

1. Node.js 20 或更高版本。
2. 高德开放平台的 Web 服务 API Key。
3. 将 Key 配置为环境变量 `AMAP_WEB_SERVICE_KEY`，不要写入仓库或聊天。

Windows PowerShell 可在本机设置用户级环境变量：

```powershell
setx AMAP_WEB_SERVICE_KEY "你的 Web 服务 Key"
```

设置后完全退出并重新打开 Codex，让插件进程读取新环境变量。仓库中的 `.env.example` 只说明变量名；插件不会从仓库文件读取真实 Key。

POI 请求节奏可通过 `AMAP_POI_SAFE_QPS` 配置，默认值为 `1`。如需直接指定最小请求间隔，可设置 `AMAP_POI_MIN_INTERVAL_MS`（毫秒），该值优先于 QPS；只有确认高德应用已获更高配额后才建议调高 QPS。门控在同一 MCP 进程的并发枚举之间共享。

## MCP 调用与续页

首次扫描传地址和场景：

```json
{"address":"深圳南山云科技大厦","city_hint":"深圳市","scene":"dine_in"}
```

当响应中的 `delivery.delivery_complete` 为 `false` 时，续页只传规范字段 `next_cursor`：

```json
{"next_cursor":"previous.delivery.next_cursor"}
```

旧输入字段 `cursor` 暂时兼容但已弃用。不得把 `address` 与任一游标同时传入；续页只读取进程内候选池，不会再次地理编码、调用高德或增加 `poi_requests_used`。

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
skills/eatrii-lab/            即时吃喝决策 Skill、Persona、品牌线索与搜索协议
tests/                        离线算法和 MCP 协议测试
```

## 数据与边界

- 位置和 POI 请求会发送到高德 Web 服务；插件只为候选分页在内存中保留结果，默认10分钟，最多8组，不写入磁盘。
- Key 只从进程环境读取，不写入结果、日志或错误文本。
- partial 结果会保留脱敏后的 provider error（内部错误码、infocode、info、端点名、尝试次数和建议重试秒数），不会保存请求 URL。
- `amap_enumeration_complete` 只表示本轮高德返回空间已闭合，不代表现实世界门店全量。
- `distance_m` 是 GCJ-02 坐标间的直线距离，不是步行时间、车程或配送范围。
- 插件不会订座、取号、付款或代下单，也不会保存动态新品结果或用户吃喝偏好。

第三方佳秀 Persona 的原始文本、来源与 MIT 许可见 `skills/eatrii-lab/references/personas/jiaxiu/`。
