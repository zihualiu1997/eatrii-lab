import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SIGNALS_PATH = fileURLToPath(
  new URL("../skills/eatrii-lab/references/brand-signals.json", import.meta.url),
);

const EXPECTED_BRANDS = new Set([
  "kfc",
  "mcdonalds",
  "dominos",
  "pizza-hut",
  "starbucks",
  "luckin",
  "manner",
  "cotti",
  "heytea",
  "naixue",
  "chagee",
  "mixue",
  "guming",
  "chabaidao",
  "auntea-jenny",
  "coco",
  "shuyi",
  "yihetang",
  "alittle-tea",
  "molly-tea",
]);

async function loadSignals() {
  return JSON.parse(await readFile(SIGNALS_PATH, "utf8"));
}

function collectKeys(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      collectKeys(child, output);
    }
  }
  return output;
}

function weekdayInShanghai(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  })
    .format(date)
    .slice(0, 2)
    .toUpperCase();
}

function isLeadEligible(signal, now) {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: signal.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return (
    signal.status === "lead_only" &&
    localDate <= signal.review_due_at &&
    signal.recurrence.by_weekday.includes(weekdayInShanghai(now))
  );
}

test("brand registry contains the required 20 unique brands with official discovery sources", async () => {
  const data = await loadSignals();
  assert.equal(data.timezone, "Asia/Shanghai");
  assert.equal(data.brands.length, 20);

  const ids = data.brands.map((brand) => brand.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(ids), EXPECTED_BRANDS);

  for (const brand of data.brands) {
    assert.ok(brand.name);
    assert.ok(Array.isArray(brand.aliases) && brand.aliases.length > 0);
    assert.ok(Array.isArray(brand.categories) && brand.categories.length > 0);
    assert.ok(Array.isArray(brand.official_sources) && brand.official_sources.length > 0);
    assert.ok(brand.official_sources.every((source) => source.url.startsWith("https://")));
    assert.ok(Array.isArray(brand.news_queries) && brand.news_queries.length > 0);
  }
});

test("recurring signals are review-bounded leads and contain no volatile commerce facts", async () => {
  const data = await loadSignals();
  const brandIds = new Set(data.brands.map((brand) => brand.id));
  const signalIds = data.signals.map((signal) => signal.id);
  assert.equal(new Set(signalIds).size, signalIds.length);
  assert.equal(data.review_policy.maximum_review_age_days, 90);
  assert.equal(data.review_policy.stale_behavior, "ignore_unless_reverified_live");

  for (const signal of data.signals) {
    assert.ok(brandIds.has(signal.brand_id));
    assert.equal(signal.status, "lead_only");
    assert.equal(signal.timezone, "Asia/Shanghai");
    assert.equal(signal.recurrence.frequency, "weekly");
    assert.ok(Array.isArray(signal.recurrence.by_weekday));
    assert.ok(signal.source_urls.length >= 2);
    assert.ok(signal.source_urls.every((url) => url.startsWith("https://")));

    const reviewed = Date.parse(`${signal.last_reviewed_at}T00:00:00Z`);
    const due = Date.parse(`${signal.review_due_at}T00:00:00Z`);
    assert.ok(Number.isFinite(reviewed) && Number.isFinite(due));
    const reviewWindowDays = (due - reviewed) / 86_400_000;
    assert.ok(reviewWindowDays > 0 && reviewWindowDays <= 90);
  }

  const forbiddenKeys = new Set([
    "price",
    "promo_price",
    "discount_price",
    "menu",
    "stock",
    "inventory",
    "participating_stores",
  ]);
  const keys = collectKeys(data.signals);
  assert.deepEqual(keys.filter((key) => forbiddenKeys.has(key)), []);
});

test("only evidence-backed long-running campaigns are stored as signals", async () => {
  const data = await loadSignals();
  const signalIds = new Set(data.signals.map((signal) => signal.id));
  assert.ok(signalIds.has("kfc-crazy-thursday"));
  assert.ok(signalIds.has("mcdonalds-monday-savings"));
  assert.ok(![...signalIds].some((id) => id.includes("dominos")));
  assert.ok(![...signalIds].some((id) => id.includes("manner")));
});

test("Asia/Shanghai weekday and review expiry gate recurring hints", async () => {
  const data = await loadSignals();
  const kfc = data.signals.find((signal) => signal.id === "kfc-crazy-thursday");
  assert.equal(isLeadEligible(kfc, new Date("2026-08-20T04:00:00Z")), true);
  assert.equal(isLeadEligible(kfc, new Date("2026-08-21T04:00:00Z")), false);
  assert.equal(isLeadEligible(kfc, new Date("2026-11-26T04:00:00Z")), false);

  const dominosSignals = data.signals.filter((signal) => signal.brand_id === "dominos");
  assert.deepEqual(dominosSignals, []);
});
