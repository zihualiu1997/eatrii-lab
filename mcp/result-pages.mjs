import { randomUUID } from "node:crypto";

export class ResultCursorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResultCursorError";
    this.code = code;
  }
}

function boundedPageSize(value, fallback, maximum) {
  const pageSize = value === undefined ? fallback : value;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maximum) {
    throw new ResultCursorError(
      "INVALID_PAGE_SIZE",
      `result_page_size 必须是 1 到 ${maximum} 之间的整数。`,
    );
  }
  return pageSize;
}

export function createResultPager(options = {}) {
  const nowMs = options.nowMs ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const ttlMs = options.ttlMs ?? 10 * 60 * 1_000;
  const defaultPageSize = options.defaultPageSize ?? 250;
  const maximumPageSize = options.maximumPageSize ?? 500;
  const maximumResultSets = options.maximumResultSets ?? 8;
  const resultSets = new Map();
  const cursors = new Map();

  function removeResultSet(resultSetId) {
    resultSets.delete(resultSetId);
    for (const [cursor, state] of cursors) {
      if (state.resultSetId === resultSetId) {
        cursors.delete(cursor);
      }
    }
  }

  function prune() {
    const current = nowMs();
    for (const [resultSetId, resultSet] of resultSets) {
      if (resultSet.expiresAt <= current) {
        removeResultSet(resultSetId);
      }
    }
  }

  function ensureCapacity() {
    prune();
    while (resultSets.size >= maximumResultSets) {
      const oldest = [...resultSets.entries()].sort(
        (left, right) => left[1].createdAt - right[1].createdAt,
      )[0];
      if (!oldest) {
        break;
      }
      removeResultSet(oldest[0]);
    }
  }

  function newCursor(resultSetId, offset) {
    const cursor = idFactory();
    cursors.set(cursor, { resultSetId, offset, nextCursor: undefined });
    return cursor;
  }

  function renderPage(resultSet, offset, cursorState) {
    const { result, pageSize } = resultSet;
    const totalCount = result.pois.length;
    const pois = result.pois.slice(offset, offset + pageSize);
    const deliveredThrough = offset + pois.length;
    const deliveryComplete = deliveredThrough >= totalCount;
    let nextCursor;
    if (!deliveryComplete) {
      if (cursorState?.nextCursor) {
        nextCursor = cursorState.nextCursor;
      } else {
        nextCursor = newCursor(resultSet.id, deliveredThrough);
        if (cursorState) {
          cursorState.nextCursor = nextCursor;
        }
      }
    }

    return {
      ...result,
      pois,
      delivery: {
        total_count: totalCount,
        page_offset: offset,
        page_returned_count: pois.length,
        delivered_through: deliveredThrough,
        delivery_complete: deliveryComplete,
        next_cursor: nextCursor,
        cursor_ttl_seconds: Math.floor(ttlMs / 1_000),
      },
    };
  }

  function firstPage(result, requestedPageSize) {
    const pageSize = boundedPageSize(
      requestedPageSize,
      defaultPageSize,
      maximumPageSize,
    );
    const totalCount = Array.isArray(result?.pois) ? result.pois.length : 0;
    if (totalCount <= pageSize) {
      return {
        ...result,
        pois: Array.isArray(result?.pois) ? result.pois : [],
        delivery: {
          total_count: totalCount,
          page_offset: 0,
          page_returned_count: totalCount,
          delivered_through: totalCount,
          delivery_complete: true,
          next_cursor: undefined,
          cursor_ttl_seconds: Math.floor(ttlMs / 1_000),
        },
      };
    }

    ensureCapacity();
    const resultSetId = idFactory();
    const resultSet = {
      id: resultSetId,
      result,
      pageSize,
      createdAt: nowMs(),
      expiresAt: nowMs() + ttlMs,
    };
    resultSets.set(resultSetId, resultSet);
    return renderPage(resultSet, 0);
  }

  function nextPage(cursor) {
    prune();
    if (typeof cursor !== "string" || cursor.trim().length === 0) {
      throw new ResultCursorError("INVALID_CURSOR", "cursor 必须是非空字符串。" );
    }
    const state = cursors.get(cursor);
    const resultSet = state ? resultSets.get(state.resultSetId) : undefined;
    if (!state || !resultSet) {
      throw new ResultCursorError(
        "CURSOR_EXPIRED",
        "候选池分页游标不存在或已过期，请重新执行高德枚举。",
      );
    }
    resultSet.expiresAt = nowMs() + ttlMs;
    return renderPage(resultSet, state.offset, state);
  }

  return { firstPage, nextPage };
}
