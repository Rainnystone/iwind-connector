import { nextSlotId } from "./slot-ring";
import { isSlotId, KEY_SLOT_DEFINITIONS } from "./slots";

const CREATE_SLOTS = `
  CREATE TABLE IF NOT EXISTS slots (
    slot_id TEXT PRIMARY KEY,
    priority INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL,
    reset_at INTEGER,
    cooldown_until INTEGER,
    last_error_code TEXT,
    call_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

const CREATE_LEASE = `
  CREATE TABLE IF NOT EXISTS lease (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    lease_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`;

const CREATE_PENDING_TEST_OUTCOME = `
  CREATE TABLE IF NOT EXISTS pending_test_outcome (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    slot_id TEXT NOT NULL,
    category TEXT NOT NULL
  )
`;

const CREATE_OAUTH_REPLAY_MARKER = `
  CREATE TABLE IF NOT EXISTS oauth_replay_marker (
    marker_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`;

const CREATE_SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS _key_pool_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`;

const CREATE_POOL_STATE = `
  CREATE TABLE IF NOT EXISTS pool_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    cursor_slot_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

const SEED_SLOT = `
  INSERT OR IGNORE INTO slots (
    slot_id,
    priority,
    state,
    reset_at,
    cooldown_until,
    last_error_code,
    call_count,
    updated_at
  ) VALUES (?, ?, 'active', NULL, NULL, NULL, 0, 0)
`;

type LegacySlotRow = Record<string, SqlStorageValue> & {
  slot_id: string;
  priority: number;
  state: string;
  reset_at: number | null;
  updated_at: number;
};

export function initializeKeyPoolSchema(storage: DurableObjectStorage, now: number): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(CREATE_SCHEMA_MIGRATIONS);
    const currentVersion = sql
      .exec<Record<string, SqlStorageValue> & { version: number }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM _key_pool_schema_migrations",
      )
      .one().version;
    if (currentVersion > 2) throw new Error("KEY_POOL_SCHEMA_TOO_NEW");

    sql.exec(CREATE_SLOTS);
    sql.exec(CREATE_LEASE);
    sql.exec(CREATE_PENDING_TEST_OUTCOME);
    sql.exec(CREATE_OAUTH_REPLAY_MARKER);
    synchronizeSlotManifest(sql);

    if (currentVersion < 1) {
      sql.exec(
        "INSERT INTO _key_pool_schema_migrations (version, applied_at) VALUES (1, ?)",
        now,
      );
    }

    sql.exec(CREATE_POOL_STATE);
    if (currentVersion < 2) {
      const cursorSlotId = chooseLegacyCursor(sql, now);
      sql.exec(
        `UPDATE slots
         SET state = 'active', reset_at = NULL, last_error_code = 'daily_quota'
         WHERE state = 'exhausted_until_reset' AND reset_at IS NULL`,
      );
      sql.exec(
        `INSERT INTO pool_state (singleton, cursor_slot_id, updated_at)
         VALUES (1, ?, ?)`,
        cursorSlotId,
        now,
      );
      sql.exec(
        "INSERT INTO _key_pool_schema_migrations (version, applied_at) VALUES (2, ?)",
        now,
      );
    } else {
      const storedCursor = sql
        .exec<Record<string, SqlStorageValue> & { cursor_slot_id: string }>(
          "SELECT cursor_slot_id FROM pool_state WHERE singleton = 1",
        )
        .toArray()[0]?.cursor_slot_id;
      if (storedCursor === undefined || !isSlotId(storedCursor)) {
        throw new Error("INVALID_STORED_POOL_CURSOR");
      }
    }
  });
}

function synchronizeSlotManifest(sql: SqlStorage): void {
  const stored = sql
    .exec<Record<string, SqlStorageValue> & { slot_id: string; priority: number }>(
      "SELECT slot_id, priority FROM slots ORDER BY priority ASC",
    )
    .toArray();
  if (stored.length > KEY_SLOT_DEFINITIONS.length) {
    throw new Error("KEY_SLOT_MANIFEST_REMOVAL_UNSUPPORTED");
  }
  for (const [index, row] of stored.entries()) {
    const definition = KEY_SLOT_DEFINITIONS[index];
    if (
      definition === undefined ||
      row.slot_id !== definition.slotId ||
      row.priority !== definition.priority
    ) {
      throw new Error("KEY_SLOT_MANIFEST_REORDER_UNSUPPORTED");
    }
  }
  for (const definition of KEY_SLOT_DEFINITIONS.slice(stored.length)) {
    sql.exec(SEED_SLOT, definition.slotId, definition.priority);
  }
}

function chooseLegacyCursor(sql: SqlStorage, now: number): string {
  const liveLease = sql
    .exec<Record<string, SqlStorageValue> & { slot_id: string }>(
      "SELECT slot_id FROM lease WHERE singleton = 1 AND expires_at > ?",
      now,
    )
    .toArray()[0];
  if (liveLease !== undefined && isSlotId(liveLease.slot_id)) return liveLease.slot_id;

  const slots = sql.exec<LegacySlotRow>("SELECT * FROM slots ORDER BY priority ASC").toArray();
  const currentUsable = slots.find(
    ({ state }) => state === "active" || state === "cooldown",
  );
  if (currentUsable !== undefined && isSlotId(currentUsable.slot_id)) {
    return currentUsable.slot_id;
  }

  const allUnknownResetExhausted =
    slots.length > 0 &&
    slots.every(
      ({ state, reset_at: resetAt }) =>
        state === "exhausted_until_reset" && resetAt === null,
    );
  if (allUnknownResetExhausted) {
    const latest = [...slots].sort(
      (left, right) => right.updated_at - left.updated_at || right.priority - left.priority,
    )[0];
    if (latest !== undefined && isSlotId(latest.slot_id)) {
      return nextSlotId(KEY_SLOT_DEFINITIONS, latest.slot_id);
    }
  }

  const first = KEY_SLOT_DEFINITIONS[0];
  if (first === undefined) throw new Error("INVALID_SLOT_RING");
  return first.slotId;
}
