import { BadRequestException } from '@nestjs/common';

/**
 * Keyset (cursor) pagination — the one pagination style in this API.
 *
 * WHY KEYSET AND NOT OFFSET, decided at step 6 phase 3a because nothing
 * paginated before it:
 *
 *  1. **Offset is incorrect on append-only tables.** `readings` and
 *     `asset_events` are insert-heavy and never updated. With `OFFSET`, a row
 *     inserted between page 1 and page 2 shifts the window and the client
 *     silently skips a row (or sees one twice). Keyset pages from the last row
 *     seen, so concurrent inserts cannot move the window under it.
 *  2. **Depth stability.** `OFFSET n` makes Postgres walk and discard n rows;
 *     cost grows with depth. Keyset seeks. This is the same plan-shape argument
 *     `docs/PERF.md` records for the readings index.
 *  3. One style everywhere is one thing to document and one client helper.
 *
 * THE COST, ACCEPTED HONESTLY: no total count and no "page 7 of 12". A count
 * endpoint is a separate decision if step 8 needs one — it is never a reason to
 * reintroduce offset alongside this.
 *
 * ---
 *
 * **THE TIEBREAKER IS NOT OPTIONAL, AND FOR EVENTS THE TIE IS GUARANTEED.**
 *
 * Keyset pagination requires a TOTAL order. None of the sort columns is unique:
 * two readings can share a `read_at`, two assets a `created_at`. If the order is
 * only partial, rows at the boundary of a page are ordered arbitrarily between
 * queries, and a row can be skipped or repeated — the exact defect keyset was
 * chosen to avoid.
 *
 * For `asset_events` this is not a rare collision, it is a certainty by design:
 * ARCHITECTURE §9.2 has registration emit `created` AND `installed` in ONE
 * transaction, so every asset's genesis is two rows sharing a `created_at` to the
 * microsecond. A page boundary landing between them is a guaranteed bug, not a
 * race.
 *
 * So every cursor is the PAIR `(sortValue, id)`, and every `ORDER BY` carries
 * `id` in the same direction. `id` is a primary key, so the pair is total.
 */
export interface Cursor {
  /** The sort column's value, ISO-8601 for timestamps. */
  readonly k: string;
  /** The row id — the tiebreaker that makes the ordering total. */
  readonly i: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * OPAQUE ON PURPOSE. Clients must treat a cursor as a blob they hand back
 * verbatim. Base64 is not encryption and is not pretending to be — it exists so
 * that the encoding can change (a different sort key, a compound key, a version
 * tag) without breaking every stored client cursor, and so nobody builds a client
 * that constructs cursors by hand and then depends on the shape.
 *
 * A cursor carries no authorization meaning. Feeding another tenant's cursor into
 * a request reveals nothing: the query still runs under `app.current_tenant`, so
 * RLS filters the result to the caller's tenant regardless of where the cursor
 * came from. The cursor selects a POSITION, never a permission.
 */
export function encodeCursor(sortValue: Date | string, id: string): string {
  const k = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
  return Buffer.from(JSON.stringify({ k, i: id }), 'utf8').toString('base64url');
}

/**
 * Decodes a client-supplied cursor, or 400s.
 *
 * Validated rather than trusted: the value is interpolated into a comparison
 * against a `uuid` column, so a malformed `i` would surface as a `22P02` cast
 * error — a 500 for what is a client mistake. Both halves are checked and the
 * failure is a clean 400 with the project's error envelope.
 */
export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException({
      error: { code: 'INVALID_CURSOR', message: 'The cursor is not valid.' },
    });
  }

  const candidate = parsed as Partial<Cursor> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.k !== 'string' ||
    typeof candidate.i !== 'string' ||
    !UUID.test(candidate.i)
  ) {
    throw new BadRequestException({
      error: { code: 'INVALID_CURSOR', message: 'The cursor is not valid.' },
    });
  }

  return { k: candidate.k, i: candidate.i };
}

/** A page of results plus the cursor that continues it. `null` means no more rows. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * Turns `limit + 1` fetched rows into a page.
 *
 * Fetching one extra row is how "is there a next page" is answered without a
 * second query and without a count — if the extra row came back there is more,
 * and it is dropped from the response.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? cursorOf(last) : null,
  };
}
