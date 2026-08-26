import test from "node:test";
import assert from "node:assert/strict";

import {
  createPoiRateGate,
  enumerateNearby,
  haversineMeters,
  serializeAmapError,
} from "../mcp/amap-nearby.mjs";

const TEST_KEY = "TEST_AMAP_KEY_MUST_NEVER_LEAK_7f4c9a";
const CENTER = "113.950000,22.540000";
const FIXED_NOW = new Date("2026-08-20T04:00:00.000Z");

function okGeocode(overrides = {}) {
  return {
    formatted_address: "广东省深圳市南山区云科技大厦",
    country: "中国",
    province: "广东省",
    city: "深圳市",
    district: "南山区",
    adcode: "440305",
    location: CENTER,
    level: "门牌号",
    ...overrides,
  };
}

function poi(id, name, address, location = CENTER, overrides = {}) {
  return {
    id,
    name,
    type: "餐饮服务;中餐厅;中餐厅",
    typecode: "050100",
    address,
    location,
    pname: "广东省",
    cityname: "深圳市",
    adname: "南山区",
    business: {
      business_area: "科技园",
      tag: "中餐",
      cost: "28.00",
    },
    ...overrides,
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function apiOk(pois) {
  return {
    status: "1",
    info: "OK",
    infocode: "10000",
    count: String(pois.length),
    pois,
  };
}

function reasonText(result) {
  return (result.partial_reasons ?? [])
    .map((reason) => (typeof reason === "string" ? reason : JSON.stringify(reason)))
    .join(" ");
}

function assertSecretAbsent(value) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(TEST_KEY));
}

function polygonArea(rawPolygon) {
  const points = String(rawPolygon)
    .split("|")
    .map((point) => point.split(",").map(Number));
  assert.ok(points.length >= 2, `unexpected polygon: ${rawPolygon}`);
  const longitudes = points.map(([longitude]) => longitude);
  const latitudes = points.map(([, latitude]) => latitude);
  return (
    (Math.max(...longitudes) - Math.min(...longitudes)) *
    (Math.max(...latitudes) - Math.min(...latitudes))
  );
}

function createFetch({ geocodePayload, poiHandler }) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push(url);

    if (url.pathname === "/v3/geocode/geo") {
      const payload = geocodePayload ?? {
        status: "1",
        info: "OK",
        infocode: "10000",
        count: "1",
        geocodes: [okGeocode()],
      };
      return jsonResponse(payload);
    }

    if (url.pathname === "/v5/place/around" || url.pathname === "/v5/place/polygon") {
      const result = await poiHandler(url);
      return result instanceof Response ? result : jsonResponse(result);
    }

    throw new Error(`unexpected endpoint: ${url.pathname}`);
  };

  return { fetchImpl, calls };
}

function enumerate(args, fetchImpl, options = {}) {
  return enumerateNearby(args, {
    fetchImpl,
    env: {
      AMAP_WEB_SERVICE_KEY: TEST_KEY,
      AMAP_POI_MIN_INTERVAL_MS: "0",
      ...options.env,
    },
    now: () => FIXED_NOW,
    sleepImpl: options.sleepImpl ?? (async () => {}),
    nowMs: options.nowMs,
    random: options.random ?? (() => 0),
    poiRateGate: options.poiRateGate,
  });
}

test("one short around page closes the candidate pool", async () => {
  const expected = [
    poi("p1", "老王猪脚饭", "科苑路1号", "113.950400,22.540000"),
    poi("p2", "阿香云南米线", "科苑路2号", "113.950800,22.540000"),
  ];
  const { fetchImpl, calls } = createFetch({
    poiHandler: (url) => {
      assert.equal(url.pathname, "/v5/place/around");
      assert.equal(url.searchParams.get("page_size"), "25");
      assert.equal(url.searchParams.get("page_num"), "1");
      assert.equal(url.searchParams.get("types"), "050000");
      return apiOk(expected);
    },
  });

  const result = await enumerate(
    { address: "深圳南山云科技大厦", city_hint: "深圳", radius_m: 800 },
    fetchImpl,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.coverage_status, "amap_enumeration_complete");
  assert.deepEqual(result.partial_reasons, []);
  assert.equal(result.audit.poi_requests_used, 1);
  assert.deepEqual(result.pois.map((item) => item.id), ["p1", "p2"]);
  assert.equal(calls.filter((url) => url.pathname.includes("/place/")).length, 1);
  assertSecretAbsent(result);
});

test("a full 200-row around scan switches to polygon cells and bisects saturated space", async () => {
  const polygonBounds = [];
  const { fetchImpl, calls } = createFetch({
    poiHandler: (url) => {
      const page = Number(url.searchParams.get("page_num"));
      if (url.pathname === "/v5/place/around") {
        return apiOk(
          Array.from({ length: 25 }, (_, index) =>
            poi(`around-${page}-${index}`, `周边店${page}-${index}`, `周边地址${page}-${index}`),
          ),
        );
      }

      const polygon = url.searchParams.get("polygon");
      polygonBounds.push(polygon);
      if (polygonArea(polygon) > 0.00013) {
        return apiOk(
          Array.from({ length: 25 }, (_, index) =>
            poi(`root-${page}-${index}`, `根网格店${page}-${index}`, `根网格地址${page}-${index}`),
          ),
        );
      }

      return apiOk([
        poi(
          `leaf-${polygon}`,
          `叶网格店-${polygon}`,
          `叶网格地址-${polygon}`,
          CENTER,
        ),
      ]);
    },
  });

  const result = await enumerate(
    {
      address: "深圳南山云科技大厦",
      city_hint: "深圳",
      radius_m: 750,
      max_poi_requests: 64,
    },
    fetchImpl,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.coverage_status, "amap_enumeration_complete");
  assert.ok(polygonBounds.length >= 2, "expected more than one polygon cell");
  assert.ok(new Set(polygonBounds).size >= 2, "expected adaptive child polygons");
  const [rootTopLeft] = polygonBounds[0]
    .split("|")
    .map((point) => point.split(",").map(Number));
  assert.ok(
    haversineMeters(
      { longitude: 113.95, latitude: 22.54 },
      { longitude: 113.95, latitude: rootTopLeft[1] },
    ) >= 750,
    "root polygon must conservatively contain the requested circle",
  );
  assert.equal(
    result.audit.poi_requests_used,
    calls.filter((url) => url.pathname.includes("/place/")).length,
  );
  assert.ok(result.pois.length >= 200);
  assertSecretAbsent(result);
});

test("POI request budget exhaustion is explicit and does not count geocoding", async () => {
  const { fetchImpl, calls } = createFetch({
    poiHandler: (url) => {
      const page = Number(url.searchParams.get("page_num"));
      return apiOk(
        Array.from({ length: 25 }, (_, index) =>
          poi(`budget-${page}-${index}`, `预算店${page}-${index}`, `预算地址${page}-${index}`),
        ),
      );
    },
  });

  const result = await enumerate(
    { address: "深圳南山云科技大厦", radius_m: 800, max_poi_requests: 8 },
    fetchImpl,
  );

  assert.equal(result.coverage_status, "partial");
  assert.match(reasonText(result), /budget/i);
  assert.equal(result.audit.poi_requests_used, 8);
  assert.deepEqual(result.audit.request_counts.poi, { logical_requests: 8, attempts: 8 });
  assert.deepEqual(result.provider_errors, []);
  assert.equal(result.pois.length, 200, "already fetched rows must survive a budget stop");
  assert.equal(calls.filter((url) => url.pathname.includes("/place/")).length, 8);
  assert.equal(calls.filter((url) => url.pathname.includes("/geocode/")).length, 1);
  assertSecretAbsent(result);
});

test("geocode infocode errors return a sanitized structured failure", async () => {
  const { fetchImpl } = createFetch({
    geocodePayload: {
      status: "0",
      info: "INVALID_USER_KEY",
      infocode: "10001",
      count: "0",
      geocodes: [],
    },
    poiHandler: () => {
      throw new Error("POI search must not run after geocode failure");
    },
  });

  await assert.rejects(
    enumerate({ address: "深圳南山云科技大厦" }, fetchImpl),
    (error) => {
      const safe = serializeAmapError(error);
      assert.equal(safe.code, "AMAP_PROVIDER_UNAVAILABLE");
      assert.equal(safe.infocode, "10001");
      assertSecretAbsent(safe);
      return true;
    },
  );
});

test("POI infocode errors are visible without exposing credentials", async () => {
  const { fetchImpl } = createFetch({
    poiHandler: () => ({
      status: "0",
      info: "INVALID_PARAMS",
      infocode: "20000",
      count: "0",
      pois: [],
    }),
  });

  const result = await enumerate({ address: "深圳南山云科技大厦" }, fetchImpl);

  assert.notEqual(result.status, "ok");
  assert.match(reasonText(result), /poi|amap|api/i);
  assertSecretAbsent(result);
});

test("HTTP 429 honors Retry-After before retrying", async () => {
  const waits = [];
  let poiAttempts = 0;
  const { fetchImpl } = createFetch({
    poiHandler: () => {
      poiAttempts += 1;
      if (poiAttempts === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "3" } });
      }
      return apiOk([]);
    },
  });
  const result = await enumerate(
    { address: "深圳南山云科技大厦" },
    fetchImpl,
    { sleepImpl: async (ms) => waits.push(ms) },
  );

  assert.equal(result.coverage_status, "amap_enumeration_complete");
  assert.deepEqual(waits, [3_000]);
  assert.equal(result.audit.poi_requests_used, 2);
  assert.deepEqual(result.audit.request_counts.poi, { logical_requests: 1, attempts: 2 });
});

test("Amap limit, busy, and quota infocodes have distinct classifications", async (t) => {
  const cases = [
    {
      infocode: "10004",
      info: `USER_DAILY_QUERY_OVER_LIMIT ${TEST_KEY}`,
      expectedInfo: "USER_DAILY_QUERY_OVER_LIMIT [REDACTED]",
      code: "AMAP_RATE_LIMITED",
      reason: "rate_limited",
      attempts: 1,
      waits: [],
      retryAfter: 60,
    },
    {
      infocode: "10021",
      info: "CUQPS_HAS_EXCEEDED_THE_LIMIT",
      code: "AMAP_RATE_LIMITED",
      reason: "rate_limited",
      attempts: 3,
      waits: [500, 1_000],
      retryAfter: 2,
    },
    {
      infocode: "10016",
      info: "SERVER_IS_BUSY",
      code: "AMAP_PROVIDER_BUSY",
      reason: "provider_busy",
      attempts: 1,
      waits: [],
      retryAfter: null,
    },
    {
      infocode: "10003",
      info: "DAILY_QUERY_OVER_LIMIT",
      code: "AMAP_DAILY_QUOTA_EXHAUSTED",
      reason: "daily_quota_exhausted",
      attempts: 1,
      waits: [],
      retryAfter: null,
    },
  ];

  for (const expected of cases) {
    await t.test(expected.infocode, async () => {
      const waits = [];
      const { fetchImpl } = createFetch({
        poiHandler: () => ({
          status: "0",
          info: expected.info,
          infocode: expected.infocode,
          count: "0",
          pois: [],
        }),
      });
      const result = await enumerate(
        { address: "深圳南山云科技大厦" },
        fetchImpl,
        { sleepImpl: async (ms) => waits.push(ms) },
      );

      assert.equal(result.coverage_status, "partial");
      assert.ok(result.partial_reasons.includes(expected.reason));
      assert.deepEqual(waits, expected.waits);
      assert.equal(result.audit.poi_requests_used, expected.attempts);
      assert.deepEqual(result.audit.request_counts.poi, {
        logical_requests: 1,
        attempts: expected.attempts,
      });
      assert.deepEqual(result.provider_errors, [{
        code: expected.code,
        message: `高德周边 POI返回错误（${expected.infocode}）。`,
        coverage_status: "partial",
        endpoint: "周边 POI",
        infocode: expected.infocode,
        info: expected.expectedInfo ?? expected.info,
        attempts: expected.attempts,
        retry_after_seconds: expected.retryAfter,
      }]);
      assertSecretAbsent(result);
    });
  }
});

test("successful POI requests honor the configured minimum interval", async () => {
  let clock = 0;
  const starts = [];
  const sleepImpl = async (ms) => { clock += ms; };
  const rateGate = createPoiRateGate({ nowMs: () => clock, sleepImpl });
  const fullPage = Array.from({ length: 25 }, (_, index) =>
    poi(`paced-${index}`, `节奏店${index}`, `节奏地址${index}`),
  );
  const { fetchImpl } = createFetch({
    poiHandler: (url) => url.searchParams.get("page_num") === "1" ? apiOk(fullPage) : apiOk([]),
  });
  const observingFetch = async (input, init) => {
    if (new URL(input).pathname.includes("/place/")) starts.push(clock);
    return fetchImpl(input, init);
  };

  const result = await enumerate(
    { address: "深圳南山云科技大厦" },
    observingFetch,
    {
      env: { AMAP_POI_MIN_INTERVAL_MS: "40" },
      nowMs: () => clock,
      sleepImpl,
      poiRateGate: rateGate,
    },
  );

  assert.deepEqual(starts, [0, 40]);
  assert.equal(result.audit.rate_limit.configured_min_interval_ms, 40);
  assert.equal(result.audit.rate_limit.minimum_observed_poi_interval_ms, 40);
});

test("concurrent enumerations share one process-level POI rate gate", async () => {
  let clock = 0;
  const starts = [];
  const sleepImpl = async (ms) => { clock += ms; };
  const sharedGate = createPoiRateGate({ nowMs: () => clock, sleepImpl });
  const { fetchImpl } = createFetch({ poiHandler: () => apiOk([]) });
  const observingFetch = async (input, init) => {
    if (new URL(input).pathname.includes("/place/")) starts.push(clock);
    return fetchImpl(input, init);
  };
  const options = {
    env: { AMAP_POI_MIN_INTERVAL_MS: "35" },
    nowMs: () => clock,
    sleepImpl,
    poiRateGate: sharedGate,
  };

  await Promise.all([
    enumerate({ address: "深圳南山云科技大厦 A" }, observingFetch, options),
    enumerate({ address: "深圳南山云科技大厦 B" }, observingFetch, options),
  ]);

  assert.deepEqual(starts, [0, 35]);
});

test("a repeated provider page is partial and preserves earlier rows", async () => {
  const repeated = Array.from({ length: 25 }, (_, index) =>
    poi(`repeat-${index}`, `重复页店${index}`, `重复页地址${index}`),
  );
  const { fetchImpl } = createFetch({ poiHandler: () => apiOk(repeated) });

  const result = await enumerate(
    { address: "深圳南山云科技大厦", max_poi_requests: 8 },
    fetchImpl,
  );

  assert.equal(result.coverage_status, "partial");
  assert.match(reasonText(result), /provider_inconsistent/);
  assert.equal(result.pois.length, 25);
  assertSecretAbsent(result);
});

test("ambiguous or city-level geocoding stops with location_unresolved", async (t) => {
  await t.test("multiple geocodes", async () => {
    let poiCalled = false;
    const { fetchImpl } = createFetch({
      geocodePayload: {
        status: "1",
        info: "OK",
        infocode: "10000",
        count: "2",
        geocodes: [
          okGeocode({ formatted_address: "深圳市南山区云科技大厦" }),
          okGeocode({ formatted_address: "广州市天河区云科技大厦", city: "广州市", adcode: "440106" }),
        ],
      },
      poiHandler: () => {
        poiCalled = true;
        return apiOk([]);
      },
    });

    const result = await enumerate({ address: "云科技大厦" }, fetchImpl);
    assert.equal(result.status, "location_unresolved");
    assert.deepEqual(result.pois, []);
    assert.equal(poiCalled, false);
    assertSecretAbsent(result);
  });

  await t.test("coarse city-level match", async () => {
    let poiCalled = false;
    const { fetchImpl } = createFetch({
      geocodePayload: {
        status: "1",
        info: "OK",
        infocode: "10000",
        count: "1",
        geocodes: [
          okGeocode({
            formatted_address: "广东省深圳市",
            district: [],
            adcode: "440300",
            level: "市",
          }),
        ],
      },
      poiHandler: () => {
        poiCalled = true;
        return apiOk([]);
      },
    });

    const result = await enumerate({ address: "深圳" }, fetchImpl);
    assert.equal(result.status, "location_unresolved");
    assert.deepEqual(result.pois, []);
    assert.equal(poiCalled, false);
    assertSecretAbsent(result);
  });
});

test("deduplication keeps distinct Amap ids and uses normalized name plus address only as fallback", async () => {
  const candidates = [
    poi("same-id", "同ID原店", "科技园A座"),
    poi("same-id", "同ID重复店", "科技园B座"),
    poi("normalized-1", " 小 李 米线 ", "科技园  1号"),
    poi("normalized-2", "小李米线", "科技园1号"),
    poi("branch-1", "陈记小炒", "科技园2号"),
    poi("branch-2", "陈记小炒", "科技园3号"),
    poi("", "无ID汤粉", "科技园4号", "113.950100,22.540000"),
    poi("", "无 ID 汤粉", "科技园 4号", "113.950100,22.540000"),
    poi("", "无ID汤粉", "科技园4号", "113.951100,22.540000"),
  ];
  const { fetchImpl } = createFetch({ poiHandler: () => apiOk(candidates) });

  const result = await enumerate({ address: "深圳南山云科技大厦", radius_m: 800 }, fetchImpl);

  assert.equal(result.coverage_status, "amap_enumeration_complete");
  assert.equal(result.pois.length, 7);
  assert.equal(result.pois.filter((item) => item.id === "same-id").length, 1);
  assert.equal(result.pois.filter((item) => item.name.replaceAll(" ", "") === "小李米线").length, 2);
  assert.equal(result.pois.filter((item) => item.name === "陈记小炒").length, 2);
  assert.equal(result.pois.filter((item) => item.name.replaceAll(" ", "") === "无ID汤粉").length, 2);
  assertSecretAbsent(result);
});

test("POIs outside the requested circle are removed after square-cell discovery", async () => {
  const { fetchImpl } = createFetch({
    poiHandler: () =>
      apiOk([
        poi("inside", "圈内店", "近处", "113.950000,22.541000"),
        poi("outside", "圈外店", "远处", "113.950000,22.550000"),
      ]),
  });

  const result = await enumerate({ address: "深圳南山云科技大厦", radius_m: 500 }, fetchImpl);

  assert.deepEqual(result.pois.map((item) => item.id), ["inside"]);
  assert.ok(result.pois[0].distance_m <= 500);
  assertSecretAbsent(result);
});

test("reversing Amap result order does not change final POI order or fields", async () => {
  const candidates = [
    poi("farther", "乙店", "科苑路乙号", "113.950000,22.542000"),
    poi("nearer", "甲店", "科苑路甲号", "113.950000,22.541000"),
  ];
  const firstFetch = createFetch({ poiHandler: () => apiOk(candidates) }).fetchImpl;
  const reversedFetch = createFetch({ poiHandler: () => apiOk([...candidates].reverse()) }).fetchImpl;

  const args = { address: "深圳南山云科技大厦", radius_m: 800 };
  const first = await enumerate(args, firstFetch);
  const second = await enumerate(args, reversedFetch);

  assert.deepEqual(first.pois, second.pois);
  assert.deepEqual(first.pois.map((item) => item.id), ["nearer", "farther"]);
  assertSecretAbsent(first);
  assertSecretAbsent(second);
});

test("a fetch error containing the request URL cannot leak the configured key", async () => {
  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    throw new Error(`simulated network error for ${url}`);
  };

  let rendered;
  try {
    rendered = JSON.stringify(
      await enumerateNearby(
        { address: "深圳南山云科技大厦" },
        {
          fetchImpl,
          env: { AMAP_WEB_SERVICE_KEY: TEST_KEY },
          now: () => FIXED_NOW,
          sleepImpl: async () => {},
        },
      ),
    );
  } catch (error) {
    rendered = `${error?.message ?? error}\n${error?.stack ?? ""}`;
  }

  assert.doesNotMatch(rendered, new RegExp(TEST_KEY));
});
