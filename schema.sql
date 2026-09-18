-- Shared SMS grocery list — D1 (SQLite) schema
-- Run: wrangler d1 execute grocery --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS households (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id),
  phone_e164    TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone_e164);

CREATE TABLE IF NOT EXISTS trips (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id),
  opened_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,
  closed_by     INTEGER REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_trips_open ON trips(household_id, closed_at);

CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY,
  trip_id         INTEGER NOT NULL REFERENCES trips(id),
  canonical_name  TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  quantity_text   TEXT,
  note            TEXT,
  added_by        INTEGER NOT NULL REFERENCES members(id),
  removed_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The safety net: two simultaneous "milk" texts cannot create two rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_dedupe ON items(trip_id, canonical_name);
CREATE INDEX IF NOT EXISTS idx_items_trip ON items(trip_id, removed_at);

CREATE TABLE IF NOT EXISTS mentions (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  raw_text    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mentions_item ON mentions(item_id);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  member_id   INTEGER REFERENCES members(id),
  direction   TEXT NOT NULL,
  body        TEXT NOT NULL,
  intent      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
