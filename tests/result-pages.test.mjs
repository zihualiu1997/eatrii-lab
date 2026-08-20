import test from "node:test";
import assert from "node:assert/strict";

import {
  createResultPager,
  ResultCursorError,
} from "../mcp/result-pages.mjs";

test("large POI ledgers are delivered through stable cursor pages", () => {
  let id = 0;
  const pager = createResultPager({
    defaultPageSize: 2,
    maximumPageSize: 5,
    idFactory: () => `opaque-${++id}`,
  });
  const result = {
    status: "ok",
    coverage_status: "amap_enumeration_complete",
    pois: Array.from({ length: 5 }, (_, index) => ({ id: `poi-${index}` })),
  };

  const first = pager.firstPage(result);
  assert.deepEqual(first.pois.map((poi) => poi.id), ["poi-0", "poi-1"]);
  assert.equal(first.delivery.total_count, 5);
  assert.equal(first.delivery.delivery_complete, false);

  const second = pager.nextPage(first.delivery.next_cursor);
  const secondAgain = pager.nextPage(first.delivery.next_cursor);
  assert.deepEqual(secondAgain, second, "repeating a cursor must be idempotent");
  assert.deepEqual(second.pois.map((poi) => poi.id), ["poi-2", "poi-3"]);
  assert.equal(second.delivery.delivery_complete, false);

  const third = pager.nextPage(second.delivery.next_cursor);
  assert.deepEqual(third.pois.map((poi) => poi.id), ["poi-4"]);
  assert.equal(third.delivery.delivery_complete, true);
  assert.equal(third.delivery.delivered_through, 5);
  assert.equal(third.delivery.next_cursor, undefined);
});

test("expired cursors fail explicitly", () => {
  let now = 1_000;
  let id = 0;
  const pager = createResultPager({
    nowMs: () => now,
    ttlMs: 50,
    defaultPageSize: 1,
    idFactory: () => `opaque-${++id}`,
  });
  const first = pager.firstPage({ pois: [{ id: "a" }, { id: "b" }] });
  now += 51;
  assert.throws(
    () => pager.nextPage(first.delivery.next_cursor),
    (error) => error instanceof ResultCursorError && error.code === "CURSOR_EXPIRED",
  );
});
