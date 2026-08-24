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

const SEED_SLOTS = `
  INSERT OR IGNORE INTO slots (
    slot_id,
    priority,
    state,
    reset_at,
    cooldown_until,
    last_error_code,
    call_count,
    updated_at
  ) VALUES
    ('key-01', 1, 'active', NULL, NULL, NULL, 0, 0),
    ('key-02', 2, 'active', NULL, NULL, NULL, 0, 0)
`;

export function initializeKeyPoolSchema(sql: SqlStorage): void {
  sql.exec(CREATE_SLOTS);
  sql.exec(CREATE_LEASE);
  sql.exec(SEED_SLOTS);
}
