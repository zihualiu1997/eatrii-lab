const GEOCODE_ENDPOINT = "https://restapi.amap.com/v3/geocode/geo";
const AROUND_ENDPOINT = "https://restapi.amap.com/v5/place/around";
const POLYGON_ENDPOINT = "https://restapi.amap.com/v5/place/polygon";

const DINING_TYPE = "050000";
const PAGE_SIZE = 25;
const MAX_PAGES = 8;
const MIN_CELL_SIDE_METERS = 50;
const MAX_SPLIT_DEPTH = 16;
const REQUEST_TIMEOUT_MS = 12_000;
const EARTH_RADIUS_M = 6_371_008.8;
const BOUNDING_PADDING_M = 5;
const COVERAGE_NOTE = "高德当前返回范围已闭合，不代表现实中的全部门店。";

const SCENE_DEFAULTS = Object.freeze({
  dine_in: { radiusM: 1_500, poiBudget: 96 },
  delivery: { radiusM: 3_000, poiBudget: 96 },
  business_casual: { radiusM: 3_000, poiBudget: 96 },
  business_formal: { radiusM: 5_000, poiBudget: 160 },
});

const COARSE_GEOCODE_LEVELS = new Set([
  "国家",
  "省",
  "市",
  "区县",
  "开发区",
  "乡镇",
  "村庄",
  "道路",
]);

const RETRYABLE_INFOCODES = new Set([
  "10004",
  "10014",
  "10015",
  "10016",
  "10019",
  "10020",
  "10021",
]);
const QUOTA_INFOCODES = new Set(["10003", "10044"]);
const CONFIG_INFOCODES = new Set([
  "10001",
  "10002",
  "10005",
  "10006",
  "10007",
  "10008",
  "10009",
  "10010",
  "10011",
  "10012",
  "10013",
  "10017",
  "10018",
  "10024",
  "10026",
  "10029",
  "10030",
  "10031",
  "10032",
  "10041",
  "10043",
]);

export class AmapToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AmapToolError";
    this.code = code;
    this.details = details;
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AmapToolError("INVALID_ARGUMENT", `${field} 必须是非空字符串。`, {
      field,
    });
  }
  return value.trim();
}

function optionalTrimmedString(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AmapToolError("INVALID_ARGUMENT", `${field} 必须是字符串。`, {
      field,
    });
  }
  return value.trim() || undefined;
}

function boundedInteger(value, fallback, min, max, field) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new AmapToolError(
      "INVALID_ARGUMENT",
      `${field} 必须是 ${min} 到 ${max} 之间的整数。`,
      { field },
    );
  }
  return resolved;
}

function stringValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join("、");
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function normalizeText(value) {
  return stringValue(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function parseLocation(value) {
  const [longitudeText, latitudeText] = stringValue(value).split(",");
  const longitude = Number(longitudeText);
  const latitude = Number(latitudeText);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return undefined;
  }
  return { longitude, latitude };
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

export function haversineMeters(from, to) {
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const latitude1 = toRadians(from.latitude);
  const latitude2 = toRadians(to.latitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorDetails(error, coverageStatus = "provider_unavailable") {
  if (error instanceof AmapToolError) {
    return {
      code: error.code,
      message: error.message,
      coverage_status: error.details.coverage_status ?? coverageStatus,
      endpoint: error.details.endpoint,
      infocode: error.details.infocode,
    };
  }
  return {
    code: "AMAP_UNKNOWN_ERROR",
    message: "高德服务请求失败。",
    coverage_status: coverageStatus,
  };
}

export function serializeAmapError(error) {
  return safeErrorDetails(error);
}

function requestBudgetAvailable(state, requestKind) {
  return requestKind !== "poi" || state.poiRequestsUsed < state.poiRequestBudget;
}

function recordRequest(state, requestKind) {
  if (requestKind === "poi") {
    state.poiRequestsUsed += 1;
  } else {
    state.geocodeRequests += 1;
  }
}

function classifyProviderError(infocode) {
  if (QUOTA_INFOCODES.has(infocode)) {
    return "AMAP_DAILY_QUOTA_EXHAUSTED";
  }
  if (CONFIG_INFOCODES.has(infocode)) {
    return "AMAP_PROVIDER_UNAVAILABLE";
  }
  if (RETRYABLE_INFOCODES.has(infocode)) {
    return "AMAP_RATE_LIMITED";
  }
  return "AMAP_API_ERROR";
}

async function fetchAmapJson(
  endpoint,
  endpointName,
  params,
  state,
  requestKind,
) {
  const maxAttempts = 3;
  let lastRetryableError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!requestBudgetAvailable(state, requestKind)) {
      throw new AmapToolError("REQUEST_BUDGET_EXHAUSTED", "高德 POI 请求预算已用完。", {
        endpoint: endpointName,
        coverage_status: "partial",
      });
    }

    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    url.searchParams.set("key", state.apiKey);

    recordRequest(state, requestKind);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await state.fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      lastRetryableError = new AmapToolError(
        "AMAP_NETWORK_ERROR",
        `高德${endpointName}请求失败。`,
        { endpoint: endpointName, coverage_status: "partial" },
      );
      if (attempt < maxAttempts && requestBudgetAvailable(state, requestKind)) {
        await state.sleepImpl(100 * 2 ** (attempt - 1));
        continue;
      }
      throw lastRetryableError;
    }

    if (!response?.ok) {
      clearTimeout(timer);
      const status = Number(response?.status) || 0;
      const retryable = status === 429 || status >= 500;
      lastRetryableError = new AmapToolError(
        status === 429 ? "AMAP_RATE_LIMITED" : "AMAP_HTTP_ERROR",
        `高德${endpointName}返回 HTTP ${status || "错误"}。`,
        { endpoint: endpointName, status, coverage_status: "partial" },
      );
      if (
        retryable &&
        attempt < maxAttempts &&
        requestBudgetAvailable(state, requestKind)
      ) {
        await state.sleepImpl(100 * 2 ** (attempt - 1));
        continue;
      }
      throw lastRetryableError;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      clearTimeout(timer);
      throw new AmapToolError(
        "AMAP_INVALID_RESPONSE",
        `高德${endpointName}返回了无法解析的数据。`,
        { endpoint: endpointName, coverage_status: "partial" },
      );
    }
    clearTimeout(timer);

    if (String(payload?.status) !== "1") {
      const infocode = stringValue(payload?.infocode);
      const code = classifyProviderError(infocode);
      lastRetryableError = new AmapToolError(
        code,
        `高德${endpointName}返回错误${infocode ? `（${infocode}）` : ""}。`,
        {
          endpoint: endpointName,
          infocode: infocode || undefined,
          coverage_status: code === "AMAP_PROVIDER_UNAVAILABLE" ? "provider_unavailable" : "partial",
        },
      );
      if (
        RETRYABLE_INFOCODES.has(infocode) &&
        attempt < maxAttempts &&
        requestBudgetAvailable(state, requestKind)
      ) {
        await state.sleepImpl(100 * 2 ** (attempt - 1));
        continue;
      }
      throw lastRetryableError;
    }

    return payload;
  }

  throw lastRetryableError;
}

function geocodeCandidate(raw) {
  const location = parseLocation(raw?.location);
  if (!location) {
    return undefined;
  }
  return {
    formatted_address: stringValue(raw?.formatted_address),
    country: stringValue(raw?.country),
    province: stringValue(raw?.province),
    city: stringValue(raw?.city),
    district: stringValue(raw?.district),
    township: stringValue(raw?.township),
    neighborhood: stringValue(raw?.neighborhood?.name ?? raw?.neighborhood),
    building: stringValue(raw?.building?.name ?? raw?.building),
    adcode: stringValue(raw?.adcode),
    level: stringValue(raw?.level),
    location,
  };
}

function geocodeSpecificity(candidate) {
  const rankings = new Map([
    ["兴趣点", 8],
    ["门牌号", 7],
    ["门址", 7],
    ["单元号", 7],
    ["地铁站", 6],
    ["公交站", 6],
    ["道路交叉口", 5],
    ["热点商圈", 4],
  ]);
  return rankings.get(candidate.level) ?? 3;
}

function publicGeocodeCandidate(candidate) {
  return {
    formatted_address: candidate.formatted_address,
    city: candidate.city,
    district: candidate.district,
    adcode: candidate.adcode,
    level: candidate.level,
    location: candidate.location,
  };
}

async function resolveLocation(address, cityHint, state) {
  const payload = await fetchAmapJson(
    GEOCODE_ENDPOINT,
    "地理编码",
    {
      address,
      city: cityHint,
      output: "JSON",
    },
    state,
    "geocode",
  );

  const allCandidates = (Array.isArray(payload?.geocodes) ? payload.geocodes : [])
    .map(geocodeCandidate)
    .filter(Boolean);
  const preciseCandidates = allCandidates.filter(
    (candidate) => !COARSE_GEOCODE_LEVELS.has(candidate.level),
  );

  if (allCandidates.length === 0) {
    return {
      status: "location_unresolved",
      reason: "geocode_no_match",
      candidates: [],
    };
  }
  if (preciseCandidates.length === 0) {
    return {
      status: "location_unresolved",
      reason: "geocode_too_coarse",
      candidates: allCandidates.map(publicGeocodeCandidate),
    };
  }

  const clusters = [];
  for (const candidate of preciseCandidates) {
    const existing = clusters.find(
      (cluster) =>
        cluster[0].adcode === candidate.adcode &&
        haversineMeters(cluster[0].location, candidate.location) <= 30,
    );
    if (existing) {
      existing.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }

  if (clusters.length > 1) {
    return {
      status: "location_unresolved",
      reason: "geocode_ambiguous",
      candidates: preciseCandidates.map(publicGeocodeCandidate),
    };
  }

  const selected = [...clusters[0]].sort((left, right) => {
    const specificity = geocodeSpecificity(right) - geocodeSpecificity(left);
    if (specificity !== 0) {
      return specificity;
    }
    return JSON.stringify(publicGeocodeCandidate(left)).localeCompare(
      JSON.stringify(publicGeocodeCandidate(right)),
      "zh-CN",
    );
  })[0];
  return { status: "resolved", location: selected };
}

function boundingRectangle(center, radiusM) {
  const angularRadius = (radiusM + BOUNDING_PADDING_M) / EARTH_RADIUS_M;
  const latitudeDelta = toDegrees(angularRadius);
  const latitudeCosine = Math.abs(Math.cos(toRadians(center.latitude)));
  const longitudeDelta = latitudeCosine <= Math.sin(angularRadius)
    ? 180
    : toDegrees(Math.asin(Math.sin(angularRadius) / latitudeCosine));
  return {
    id: "root",
    depth: 0,
    west: center.longitude - longitudeDelta,
    east: center.longitude + longitudeDelta,
    south: center.latitude - latitudeDelta,
    north: center.latitude + latitudeDelta,
  };
}

function rectangleDimensionsMeters(cell) {
  const middleLatitude = (cell.north + cell.south) / 2;
  const westPoint = { longitude: cell.west, latitude: middleLatitude };
  const eastPoint = { longitude: cell.east, latitude: middleLatitude };
  const southPoint = {
    longitude: (cell.west + cell.east) / 2,
    latitude: cell.south,
  };
  const northPoint = {
    longitude: (cell.west + cell.east) / 2,
    latitude: cell.north,
  };
  return {
    width: haversineMeters(westPoint, eastPoint),
    height: haversineMeters(southPoint, northPoint),
  };
}

function rectangleIntersectsCircle(cell, center, radiusM) {
  const closest = {
    longitude: Math.max(cell.west, Math.min(center.longitude, cell.east)),
    latitude: Math.max(cell.south, Math.min(center.latitude, cell.north)),
  };
  return haversineMeters(center, closest) <= radiusM + 1;
}

function splitCell(cell) {
  const dimensions = rectangleDimensionsMeters(cell);
  if (dimensions.width >= dimensions.height) {
    const midpoint = (cell.west + cell.east) / 2;
    return [
      { ...cell, id: `${cell.id}.0`, depth: cell.depth + 1, east: midpoint },
      { ...cell, id: `${cell.id}.1`, depth: cell.depth + 1, west: midpoint },
    ];
  }
  const midpoint = (cell.south + cell.north) / 2;
  return [
    { ...cell, id: `${cell.id}.0`, depth: cell.depth + 1, north: midpoint },
    { ...cell, id: `${cell.id}.1`, depth: cell.depth + 1, south: midpoint },
  ];
}

function polygonValue(cell) {
  return `${cell.west.toFixed(6)},${cell.north.toFixed(6)}|${cell.east.toFixed(6)},${cell.south.toFixed(6)}`;
}

async function scanPages(endpoint, endpointName, params, discovery, state) {
  const entries = [];
  let previousFingerprint;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let payload;
    try {
      payload = await fetchAmapJson(
        endpoint,
        endpointName,
        {
          ...params,
          types: DINING_TYPE,
          show_fields: "business,navi",
          page_size: PAGE_SIZE,
          page_num: page,
        },
        state,
        "poi",
      );
    } catch (error) {
      if (error instanceof AmapToolError) {
        error.details.partial_entries = entries;
      }
      throw error;
    }
    const rows = Array.isArray(payload?.pois) ? payload.pois : [];
    const reportedCount = Number(payload?.count);
    if (Number.isFinite(reportedCount) && reportedCount !== rows.length) {
      throw new AmapToolError(
        "AMAP_PROVIDER_INCONSISTENT",
        `高德${endpointName}返回的页计数与结果条数不一致。`,
        {
          endpoint: endpointName,
          coverage_status: "partial",
          partial_entries: entries,
        },
      );
    }
    const fingerprint = rows.length === 0
      ? ""
      : rows
          .map((poi) =>
            [poi?.id, poi?.name, stringValue(poi?.address), poi?.location]
              .map(stringValue)
              .join("|"),
          )
          .sort()
          .join("\n");
    if (page > 1 && fingerprint && fingerprint === previousFingerprint) {
      throw new AmapToolError(
        "AMAP_PROVIDER_INCONSISTENT",
        `高德${endpointName}重复返回了同一页结果。`,
        {
          endpoint: endpointName,
          coverage_status: "partial",
          partial_entries: entries,
        },
      );
    }
    previousFingerprint = fingerprint;
    state.audit[`${discovery.mode}Pages`] += 1;
    for (const poi of rows) {
      entries.push({
        raw: poi,
        discovery: {
          mode: discovery.mode,
          page,
          cell_id: discovery.cellId,
        },
      });
    }
    if (rows.length < PAGE_SIZE) {
      return { status: "closed", entries };
    }
  }
  return { status: "saturated", entries };
}

function businessFields(raw) {
  const business = raw && typeof raw.business === "object" && !Array.isArray(raw.business)
    ? raw.business
    : {};
  return {
    business_area: stringValue(business.business_area),
    opening_hours_today: stringValue(business.opentime_today),
    opening_hours_week: stringValue(business.opentime_week),
    telephone: stringValue(business.tel ?? raw?.tel),
    tag: stringValue(business.tag),
    reference_cost: stringValue(business.cost),
  };
}

function normalizedPoiRecord(entry, center) {
  const raw = entry.raw ?? {};
  const location = parseLocation(raw.location);
  if (!location) {
    return undefined;
  }
  const name = stringValue(raw.name);
  if (!name) {
    return undefined;
  }
  const address = stringValue(raw.address);
  const id = stringValue(raw.id);
  const normalizedName = normalizeText(name);
  const normalizedAddress = normalizeText(address);
  const signature = [
    normalizedName,
    normalizedAddress || stringValue(raw.adcode),
    `${location.longitude.toFixed(4)},${location.latitude.toFixed(4)}`,
  ].join("|");
  return {
    id,
    signature,
    name,
    address,
    normalizedName,
    normalizedAddress,
    type: stringValue(raw.type),
    typecode: stringValue(raw.typecode),
    city: stringValue(raw.cityname),
    district: stringValue(raw.adname),
    adcode: stringValue(raw.adcode),
    location,
    distanceM: haversineMeters(center, location),
    business: businessFields(raw),
    entranceLocation: parseLocation(raw?.navi?.entr_location),
    discovery: entry.discovery,
  };
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    }
  };
  return { find, union };
}

function recordQuality(record) {
  const values = [
    record.address,
    record.type,
    record.typecode,
    record.city,
    record.district,
    record.adcode,
    ...Object.values(record.business),
    record.entranceLocation ? "entrance" : "",
  ];
  return values.filter(Boolean).length;
}

function stableRecordKey(record) {
  return JSON.stringify({
    id: record.id,
    name: record.name,
    address: record.address,
    location: record.location,
    type: record.type,
    typecode: record.typecode,
    city: record.city,
    district: record.district,
    adcode: record.adcode,
    business: record.business,
  });
}

function firstValue(records, selector) {
  for (const record of records) {
    const value = selector(record);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function mergePoiRecords(entries, center, radiusM) {
  const records = entries.map((entry) => normalizedPoiRecord(entry, center)).filter(Boolean);
  const groups = unionFind(records.length);
  const byId = new Map();
  const bySignature = new Map();

  records.forEach((record, index) => {
    if (record.id) {
      if (byId.has(record.id)) {
        groups.union(index, byId.get(record.id));
      } else {
        byId.set(record.id, index);
      }
    }
    if (record.signature) {
      if (!bySignature.has(record.signature)) {
        bySignature.set(record.signature, []);
      }
      bySignature.get(record.signature).push(index);
    }
  });

  for (const indexes of bySignature.values()) {
    const ids = new Set(indexes.map((index) => records[index].id).filter(Boolean));
    if (ids.size <= 1) {
      const first = indexes[0];
      for (const index of indexes.slice(1)) {
        groups.union(first, index);
      }
      continue;
    }

    const missingIdIndexes = indexes.filter((index) => !records[index].id);
    const firstMissing = missingIdIndexes[0];
    if (firstMissing !== undefined) {
      for (const index of missingIdIndexes.slice(1)) {
        groups.union(firstMissing, index);
      }
    }
  }

  const buckets = new Map();
  records.forEach((record, index) => {
    const root = groups.find(index);
    if (!buckets.has(root)) {
      buckets.set(root, []);
    }
    buckets.get(root).push(record);
  });

  const unique = [...buckets.values()].map((bucket) => {
    const ordered = [...bucket].sort((left, right) => {
      const quality = recordQuality(right) - recordQuality(left);
      return quality || stableRecordKey(left).localeCompare(stableRecordKey(right), "zh-CN");
    });
    const closest = [...bucket].sort(
      (left, right) => left.distanceM - right.distanceM || stableRecordKey(left).localeCompare(stableRecordKey(right), "zh-CN"),
    )[0];
    const business = {};
    for (const key of Object.keys(ordered[0].business)) {
      business[key] = firstValue(ordered, (record) => record.business[key]);
    }
    const amapIds = [...new Set(bucket.map((record) => record.id).filter(Boolean))].sort();
    const discoveries = [...new Set(
      bucket.map((record) =>
        [record.discovery.mode, record.discovery.page, record.discovery.cell_id]
          .filter((value) => value !== undefined)
          .join(":"),
      ),
    )].sort();

    return {
      provider: "amap",
      id: amapIds[0] || undefined,
      amap_id: amapIds[0] || undefined,
      amap_ids: amapIds,
      name: firstValue(ordered, (record) => record.name),
      address: firstValue(ordered, (record) => record.address),
      city: firstValue(ordered, (record) => record.city),
      district: firstValue(ordered, (record) => record.district),
      adcode: firstValue(ordered, (record) => record.adcode),
      type: firstValue(ordered, (record) => record.type),
      typecode: firstValue(ordered, (record) => record.typecode),
      location: closest.location,
      entrance_location: firstValue(ordered, (record) => record.entranceLocation),
      distance_m: Math.round(closest.distanceM),
      business,
      discovery_evidence: discoveries,
      _normalized_name: ordered[0].normalizedName,
      _normalized_address: ordered[0].normalizedAddress,
    };
  });

  const insideRadius = unique.filter((poi) => poi.distance_m <= radiusM + 1);
  insideRadius.sort(
    (left, right) =>
      left.distance_m - right.distance_m ||
      left._normalized_name.localeCompare(right._normalized_name, "zh-CN") ||
      left._normalized_address.localeCompare(right._normalized_address, "zh-CN") ||
      stringValue(left.amap_id).localeCompare(stringValue(right.amap_id)),
  );
  return {
    uniqueCount: unique.length,
    pois: insideRadius.map(({ _normalized_name, _normalized_address, ...poi }) => poi),
  };
}

function finalizeResult({
  address,
  cityHint,
  scene,
  center,
  resolvedLocation,
  radiusM,
  rawEntries,
  state,
  coverageStatus,
  partialReasons,
  unresolvedCells,
}) {
  const merged = mergePoiRecords(rawEntries, center, radiusM);
  return {
    status: coverageStatus === "amap_enumeration_complete" ? "ok" : "partial",
    coverage_status: coverageStatus,
    coverage_note:
      coverageStatus === "amap_enumeration_complete"
        ? COVERAGE_NOTE
        : "本轮高德枚举尚未闭合，以下仅为已经检索到的候选。",
    partial_reasons: [...new Set(partialReasons)].sort(),
    query: {
      address,
      city_hint: cityHint,
      scene,
      requested_radius_m: radiusM,
    },
    resolved_location: publicGeocodeCandidate(resolvedLocation),
    provider: "amap",
    coordinate_system: "GCJ-02",
    as_of: state.now().toISOString(),
    audit: {
      geocode_requests: state.geocodeRequests,
      poi_requests_used: state.poiRequestsUsed,
      poi_requests_budget: state.poiRequestBudget,
      around_pages: state.audit.aroundPages,
      polygon_pages: state.audit.polygonPages,
      cells_scanned: state.audit.cellsScanned,
      closed_cells: state.audit.closedCells,
      split_cells: state.audit.splitCells,
      unresolved_cells: unresolvedCells,
      candidate_count_raw: rawEntries.length,
      candidate_count_unique: merged.uniqueCount,
      candidate_count_inside_radius: merged.pois.length,
      page_size: PAGE_SIZE,
      maximum_pages_per_query: MAX_PAGES,
    },
    pois: merged.pois,
  };
}

function partialReasonForError(error) {
  const mappings = new Map([
    ["REQUEST_BUDGET_EXHAUSTED", "request_budget_exhausted"],
    ["AMAP_RATE_LIMITED", "rate_limited"],
    ["AMAP_DAILY_QUOTA_EXHAUSTED", "daily_quota_exhausted"],
    ["AMAP_NETWORK_ERROR", "cell_request_failed"],
    ["AMAP_HTTP_ERROR", "cell_request_failed"],
    ["AMAP_API_ERROR", "amap_api_error"],
    ["AMAP_INVALID_RESPONSE", "invalid_provider_response"],
    ["AMAP_PROVIDER_INCONSISTENT", "provider_inconsistent"],
  ]);
  return mappings.get(error?.code);
}

export async function enumerateNearby(args, options = {}) {
  const address = requireNonEmptyString(args?.address, "address");
  const cityHint = optionalTrimmedString(args?.city_hint, "city_hint");
  const scene = args?.scene ?? "dine_in";
  if (!Object.hasOwn(SCENE_DEFAULTS, scene)) {
    throw new AmapToolError(
      "INVALID_ARGUMENT",
      `scene 必须是 ${Object.keys(SCENE_DEFAULTS).join("、")} 之一。`,
      { field: "scene" },
    );
  }

  const defaults = SCENE_DEFAULTS[scene];
  const radiusM = boundedInteger(args?.radius_m, defaults.radiusM, 100, 10_000, "radius_m");
  const poiRequestBudget = boundedInteger(
    args?.max_poi_requests,
    defaults.poiBudget,
    1,
    256,
    "max_poi_requests",
  );
  const apiKey = optionalTrimmedString(
    options.env?.AMAP_WEB_SERVICE_KEY ?? process.env.AMAP_WEB_SERVICE_KEY,
    "AMAP_WEB_SERVICE_KEY",
  );
  if (!apiKey) {
    throw new AmapToolError(
      "AMAP_KEY_MISSING",
      "未配置 AMAP_WEB_SERVICE_KEY，无法调用高德 Web 服务。",
      { coverage_status: "provider_unavailable" },
    );
  }

  const state = {
    apiKey,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    sleepImpl: options.sleepImpl ?? sleep,
    now: options.now ?? (() => new Date()),
    geocodeRequests: 0,
    poiRequestsUsed: 0,
    poiRequestBudget,
    audit: {
      aroundPages: 0,
      polygonPages: 0,
      cellsScanned: 0,
      closedCells: 0,
      splitCells: 0,
    },
  };
  if (typeof state.fetchImpl !== "function") {
    throw new AmapToolError("FETCH_UNAVAILABLE", "当前 Node.js 环境不支持 fetch。", {
      coverage_status: "provider_unavailable",
    });
  }

  const resolution = await resolveLocation(address, cityHint, state);
  if (resolution.status !== "resolved") {
    return {
      status: "location_unresolved",
      coverage_status: "location_unresolved",
      coverage_note: "位置尚未唯一解析，未开始检索具体门店。",
      partial_reasons: [resolution.reason],
      query: { address, city_hint: cityHint, scene, requested_radius_m: radiusM },
      location_candidates: resolution.candidates,
      provider: "amap",
      coordinate_system: "GCJ-02",
      as_of: state.now().toISOString(),
      audit: {
        geocode_requests: state.geocodeRequests,
        poi_requests_used: 0,
        poi_requests_budget: poiRequestBudget,
      },
      pois: [],
    };
  }

  const center = resolution.location.location;
  const rawEntries = [];
  const partialReasons = [];
  let unresolvedCells = 0;

  let aroundResult;
  try {
    aroundResult = await scanPages(
      AROUND_ENDPOINT,
      "周边 POI",
      {
        location: `${center.longitude},${center.latitude}`,
        radius: radiusM,
        sortrule: "distance",
      },
      { mode: "around" },
      state,
    );
    rawEntries.push(...aroundResult.entries);
  } catch (error) {
    rawEntries.push(...(error?.details?.partial_entries ?? []));
    const reason = partialReasonForError(error);
    if (!reason || error.code === "AMAP_PROVIDER_UNAVAILABLE") {
      throw error;
    }
    partialReasons.push(reason);
    return finalizeResult({
      address,
      cityHint,
      scene,
      center,
      resolvedLocation: resolution.location,
      radiusM,
      rawEntries,
      state,
      coverageStatus: "partial",
      partialReasons,
      unresolvedCells: 1,
    });
  }

  if (aroundResult.status === "closed") {
    return finalizeResult({
      address,
      cityHint,
      scene,
      center,
      resolvedLocation: resolution.location,
      radiusM,
      rawEntries,
      state,
      coverageStatus: "amap_enumeration_complete",
      partialReasons,
      unresolvedCells,
    });
  }

  const queue = [boundingRectangle(center, radiusM)];
  while (queue.length > 0) {
    if (state.poiRequestsUsed >= state.poiRequestBudget) {
      partialReasons.push("request_budget_exhausted");
      unresolvedCells += queue.length;
      break;
    }

    const cell = queue.shift();
    if (!rectangleIntersectsCircle(cell, center, radiusM)) {
      continue;
    }
    state.audit.cellsScanned += 1;

    let result;
    try {
      result = await scanPages(
        POLYGON_ENDPOINT,
        "多边形 POI",
        { polygon: polygonValue(cell) },
        { mode: "polygon", cellId: cell.id },
        state,
      );
      rawEntries.push(...result.entries);
    } catch (error) {
      rawEntries.push(...(error?.details?.partial_entries ?? []));
      const reason = partialReasonForError(error);
      if (!reason || error.code === "AMAP_PROVIDER_UNAVAILABLE") {
        throw error;
      }
      partialReasons.push(reason);
      unresolvedCells += 1 + queue.length;
      break;
    }

    if (result.status === "closed") {
      state.audit.closedCells += 1;
      continue;
    }

    const dimensions = rectangleDimensionsMeters(cell);
    if (
      Math.max(dimensions.width, dimensions.height) <= MIN_CELL_SIDE_METERS ||
      cell.depth >= MAX_SPLIT_DEPTH
    ) {
      partialReasons.push("unsplittable_saturated_cell");
      unresolvedCells += 1;
      continue;
    }

    const children = splitCell(cell).filter((child) =>
      rectangleIntersectsCircle(child, center, radiusM),
    );
    if (children.length === 0) {
      partialReasons.push("unsplittable_saturated_cell");
      unresolvedCells += 1;
      continue;
    }
    state.audit.splitCells += 1;
    queue.push(...children);
  }

  const coverageStatus = partialReasons.length === 0 && unresolvedCells === 0
    ? "amap_enumeration_complete"
    : "partial";
  return finalizeResult({
    address,
    cityHint,
    scene,
    center,
    resolvedLocation: resolution.location,
    radiusM,
    rawEntries,
    state,
    coverageStatus,
    partialReasons,
    unresolvedCells,
  });
}
