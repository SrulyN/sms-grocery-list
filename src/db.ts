// All D1 access lives here. Every write that could race is a single statement
// with ON CONFLICT, so two simultaneous texts can never produce a duplicate row.

export type Member = { id: number; household_id: number; display_name: string };
export type ListItem = {
  id: number;
  display_name: string;
  quantity_text: string | null;
  note: string | null;
};

export async function findMember(db: D1Database, phone: string): Promise<Member | null> {
  return db
    .prepare('SELECT id, household_id, display_name FROM members WHERE phone_e164 = ?')
    .bind(phone)
    .first<Member>();
}

/** The open trip is the current list. Creates one if none is open. */
export async function currentTripId(db: D1Database, householdId: number): Promise<number> {
  const open = await db
    .prepare('SELECT id FROM trips WHERE household_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
    .bind(householdId)
    .first<{ id: number }>();
  if (open) return open.id;

  const created = await db
    .prepare('INSERT INTO trips (household_id) VALUES (?) RETURNING id')
    .bind(householdId)
    .first<{ id: number }>();
  return created!.id;
}

export async function getList(db: D1Database, tripId: number): Promise<ListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT id, display_name, quantity_text, note
         FROM items
        WHERE trip_id = ? AND removed_at IS NULL
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(tripId)
    .all<ListItem>();
  return results ?? [];
}

/**
 * Insert or merge one item. The UNIQUE(trip_id, canonical_name) index does the
 * final deduplication regardless of what the AI decided, so this is safe to call
 * concurrently. Returns the item id and whether it was newly created.
 */
export async function upsertItem(
  db: D1Database,
  tripId: number,
  memberId: number,
  item: { canonical_name: string; display_name: string; quantity_text: string | null; note: string | null },
  rawText: string,
): Promise<{ id: number; created: boolean }> {
  const before = await db
    .prepare('SELECT id FROM items WHERE trip_id = ? AND canonical_name = ?')
    .bind(tripId, item.canonical_name)
    .first<{ id: number }>();

  const row = await db
    .prepare(
      `INSERT INTO items (trip_id, canonical_name, display_name, quantity_text, note, added_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(trip_id, canonical_name) DO UPDATE SET
         quantity_text = COALESCE(excluded.quantity_text, items.quantity_text),
         note          = COALESCE(excluded.note, items.note),
         removed_at    = NULL,
         updated_at    = datetime('now')
       RETURNING id`,
    )
    .bind(tripId, item.canonical_name, item.display_name, item.quantity_text, item.note, memberId)
    .first<{ id: number }>();

  await db
    .prepare('INSERT INTO mentions (item_id, member_id, raw_text) VALUES (?, ?, ?)')
    .bind(row!.id, memberId, rawText)
    .run();

  return { id: row!.id, created: !before };
}

/** Apply a merge the AI identified against an existing row. */
export async function mergeInto(
  db: D1Database,
  tripId: number,
  memberId: number,
  targetId: number,
  quantity: string | null,
  note: string | null,
  rawText: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE items
          SET quantity_text = COALESCE(?, quantity_text),
              note          = COALESCE(?, note),
              removed_at    = NULL,
              updated_at    = datetime('now')
        WHERE id = ? AND trip_id = ?`,
    )
    .bind(quantity, note, targetId, tripId)
    .run();

  if (!res.meta.changes) return false;

  await db
    .prepare('INSERT INTO mentions (item_id, member_id, raw_text) VALUES (?, ?, ?)')
    .bind(targetId, memberId, rawText)
    .run();
  return true;
}

export async function removeItems(db: D1Database, tripId: number, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = await db
    .prepare(
      `UPDATE items SET removed_at = datetime('now'), updated_at = datetime('now')
        WHERE trip_id = ? AND removed_at IS NULL AND id IN (${placeholders})`,
    )
    .bind(tripId, ...ids)
    .run();
  return res.meta.changes ?? 0;
}

/** "done": close the trip and open a fresh empty one. Nothing is deleted. */
export async function closeTrip(
  db: D1Database,
  householdId: number,
  tripId: number,
  memberId: number,
): Promise<number> {
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE trip_id = ? AND removed_at IS NULL')
    .bind(tripId)
    .first<{ n: number }>();

  await db.batch([
    db
      .prepare("UPDATE trips SET closed_at = datetime('now'), closed_by = ? WHERE id = ? AND closed_at IS NULL")
      .bind(memberId, tripId),
    db.prepare('INSERT INTO trips (household_id) VALUES (?)').bind(householdId),
  ]);

  return count?.n ?? 0;
}

/** "undo": reopen the most recently closed trip if it was closed in the last hour. */
export async function undoClose(db: D1Database, householdId: number): Promise<boolean> {
  const last = await db
    .prepare(
      `SELECT id FROM trips
        WHERE household_id = ? AND closed_at IS NOT NULL
          AND closed_at > datetime('now', '-1 hour')
        ORDER BY closed_at DESC LIMIT 1`,
    )
    .bind(householdId)
    .first<{ id: number }>();
  if (!last) return false;

  await db.batch([
    db.prepare('DELETE FROM trips WHERE household_id = ? AND closed_at IS NULL').bind(householdId),
    db.prepare('UPDATE trips SET closed_at = NULL, closed_by = NULL WHERE id = ?').bind(last.id),
  ]);
  return true;
}

export async function logMessage(
  db: D1Database,
  memberId: number | null,
  direction: 'in' | 'out',
  body: string,
  intent: string | null,
): Promise<void> {
  await db
    .prepare('INSERT INTO messages (member_id, direction, body, intent) VALUES (?, ?, ?, ?)')
    .bind(memberId, direction, body.slice(0, 1600), intent)
    .run();
}

/** Cheap per-member abuse brake. */
export async function messagesToday(db: D1Database, memberId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE member_id = ? AND direction = 'in' AND created_at > datetime('now', '-1 day')`,
    )
    .bind(memberId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
