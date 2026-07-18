/**
 * Cursor-based pagination utility for list endpoints.
 *
 * This provides a consistent pagination pattern that can be applied to any
 * list endpoint. Cursor-based pagination is preferred over offset-based
 * because it performs better at scale (no OFFSET scan) and handles
 * insertions/deletions between pages gracefully.
 *
 * Usage:
 *   const { cursor, limit } = parsePagination(req.query);
 *   const allItems = getItems();
 *   const { data, nextCursor, hasMore } = paginate(allItems, cursor, limit);
 */

export interface PaginationParams {
  /** Opaque cursor pointing to the item after which to start the next page. */
  cursor?: string;
  /** Maximum number of items to return per page. */
  limit: number;
}

export interface PaginatedResponse<T> {
  /** The page of data. */
  data: T[];
  /** Cursor to pass as `cursor` query param to fetch the next page. Null when no more pages. */
  nextCursor: string | null;
  /** Whether more pages exist after this one. */
  hasMore: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parses and validates pagination query parameters.
 * Silently clamps invalid values to sensible defaults.
 */
export function parsePagination(query: {
  cursor?: string;
  limit?: string;
}): PaginationParams {
  let limit = DEFAULT_LIMIT;
  if (query.limit != null) {
    const parsed = parseInt(query.limit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }
  return { cursor: query.cursor || undefined, limit };
}

/**
 * Applies cursor-based pagination to an array of items.
 *
 * Items must already be sorted in the desired order. The cursor is
 * expected to be the `id` field of an item in the array.
 *
 * @param items  Full ordered array of items
 * @param cursor The cursor value (item id) after which to start
 * @param limit  Max items per page
 */
export function paginate<T extends { id: string }>(
  items: T[],
  cursor: string | undefined,
  limit: number,
): PaginatedResponse<T> {
  let startIndex = 0;

  if (cursor) {
    const cursorIndex = items.findIndex((item) => item.id === cursor);
    // If cursor not found, start from the beginning (graceful degradation)
    if (cursorIndex !== -1) {
      startIndex = cursorIndex + 1;
    }
  }

  const sliced = items.slice(startIndex, startIndex + limit + 1);
  const hasMore = sliced.length > limit;
  const data = hasMore ? sliced.slice(0, limit) : sliced;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return { data, nextCursor, hasMore };
}
