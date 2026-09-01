import { nextSlotId } from "./slot-ring";
import {
  KEY_POOL_GENERATIONS,
  KEY_POOL_LAYOUTS,
  KEY_SLOT_CATALOG,
  LEGACY_KEY_POOL_LAYOUT_ID,
  getKeyPoolConfiguration,
  type KeyPoolGenerationDefinition,
  type KeyPoolLayoutDefinition,
  type KeySlotCatalogEntry,
} from "./slots";

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

const CREATE_POOL_MANIFEST = `
  CREATE TABLE IF NOT EXISTS pool_manifest (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation_id TEXT NOT NULL,
    layout_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

const SEED_SLOT = `
  INSERT INTO slots (
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

const REQUIRED_PRIMARY_TABLES = [
  "_key_pool_schema_migrations",
  "slots",
  "lease",
  "pending_test_outcome",
  "oauth_replay_marker",
  "pool_state",
  "pool_manifest",
] as const;

type LegacySlotRow = Record<string, SqlStorageValue> & {
  slot_id: string;
  priority: number;
  state: string;
  reset_at: number | null;
  updated_at: number;
};

type StoredSlotRow = Record<string, SqlStorageValue> & {
  slot_id: string;
  priority: number;
};

export interface KeyPoolPersistenceConfiguration {
  readonly catalog: readonly KeySlotCatalogEntry[];
  readonly generation: KeyPoolGenerationDefinition;
  readonly targetLayout: KeyPoolLayoutDefinition;
  readonly knownLayouts: readonly KeyPoolLayoutDefinition[];
  readonly preserveLegacySchema: boolean;
}

export function runtimeKeyPoolPersistenceConfiguration(
  layoutId: string,
): KeyPoolPersistenceConfiguration {
  const configuration = getKeyPoolConfiguration(layoutId);
  return {
    catalog: KEY_SLOT_CATALOG,
    generation: configuration.generation,
    targetLayout: configuration.layout,
    knownLayouts: Object.values(KEY_POOL_LAYOUTS),
    preserveLegacySchema: layoutId === LEGACY_KEY_POOL_LAYOUT_ID,
  };
}

export function initializeKeyPoolSchema(
  storage: DurableObjectStorage,
  now: number,
  configuration: KeyPoolPersistenceConfiguration = runtimeKeyPoolPersistenceConfiguration(
    LEGACY_KEY_POOL_LAYOUT_ID,
  ),
): void {
  validatePersistenceConfiguration(configuration);
  if (configuration.preserveLegacySchema) {
    initializeLegacySchema(storage, now, configuration.targetLayout.orderedSlotIds);
    return;
  }
  initializeVersionedSchema(storage, now, configuration);
}

function initializeLegacySchema(
  storage: DurableObjectStorage,
  now: number,
  orderedSlotIds: readonly string[],
): void {
  const definitions = orderedSlotIds.map((slotId, index) => ({ slotId, priority: index + 1 }));
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(CREATE_SCHEMA_MIGRATIONS);
    const currentVersion = readSchemaVersion(sql);
    if (currentVersion > 2) throw new Error("KEY_POOL_SCHEMA_TOO_NEW");

    sql.exec(CREATE_SLOTS);
    sql.exec(CREATE_LEASE);
    sql.exec(CREATE_PENDING_TEST_OUTCOME);
    sql.exec(CREATE_OAUTH_REPLAY_MARKER);
    synchronizeLegacySlots(sql, definitions);

    if (currentVersion < 1) {
      sql.exec(
        "INSERT INTO _key_pool_schema_migrations (version, applied_at) VALUES (1, ?)",
        now,
      );
    }

    sql.exec(CREATE_POOL_STATE);
    if (currentVersion < 2) {
      const cursorSlotId = chooseLegacyCursor(sql, now, definitions);
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
      if (storedCursor === undefined || !orderedSlotIds.includes(storedCursor)) {
        throw new Error("INVALID_STORED_POOL_CURSOR");
      }
    }
  });
}

function initializeVersionedSchema(
  storage: DurableObjectStorage,
  now: number,
  configuration: KeyPoolPersistenceConfiguration,
): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    const existingTables = readTableNames(sql);
    const isEmpty = REQUIRED_PRIMARY_TABLES.every((table) => !existingTables.has(table));
    if (!isEmpty && !existingTables.has("pool_manifest")) {
      throw new Error("KEY_POOL_GENERATION_MISMATCH");
    }
    if (
      existingTables.has("pool_manifest") &&
      REQUIRED_PRIMARY_TABLES.some((table) => !existingTables.has(table))
    ) {
      throw new Error("INVALID_KEY_POOL_SCHEMA");
    }

    sql.exec(CREATE_SCHEMA_MIGRATIONS);
    sql.exec(CREATE_SLOTS);
    sql.exec(CREATE_LEASE);
    sql.exec(CREATE_PENDING_TEST_OUTCOME);
    sql.exec(CREATE_OAUTH_REPLAY_MARKER);
    sql.exec(CREATE_POOL_STATE);
    sql.exec(CREATE_POOL_MANIFEST);

    if (isEmpty) {
      initializeEmptyVersionedPool(sql, now, configuration);
      return;
    }

    const schemaVersions = readSchemaVersions(sql);
    if (schemaVersions.some((version) => version > 3)) {
      throw new Error("KEY_POOL_SCHEMA_TOO_NEW");
    }
    if (!sameVersions(schemaVersions, [1, 2, 3])) throw new Error("INVALID_KEY_POOL_SCHEMA");

    const manifest = sql
      .exec<
        Record<string, SqlStorageValue> & {
          generation_id: string;
          layout_id: string;
        }
      >("SELECT generation_id, layout_id FROM pool_manifest WHERE singleton = 1")
      .toArray()[0];
    if (manifest === undefined) throw new Error("INVALID_KEY_POOL_MANIFEST");
    if (manifest.generation_id !== configuration.generation.generationId) {
      throw new Error("KEY_POOL_GENERATION_MISMATCH");
    }
    const storedLayout = configuration.knownLayouts.find(
      ({ layoutId }) => layoutId === manifest.layout_id,
    );
    if (storedLayout === undefined) throw new Error("UNKNOWN_STORED_KEY_POOL_LAYOUT");
    if (storedLayout.generationId !== manifest.generation_id) {
      throw new Error("KEY_POOL_GENERATION_MISMATCH");
    }

    assertStoredLayout(sql, storedLayout, configuration.catalog);
    assertStoredCursorAndLease(sql, storedLayout.orderedSlotIds);

    const target = configuration.targetLayout;
    if (target.layoutId === storedLayout.layoutId) return;
    if (!isStrictPrefix(storedLayout.orderedSlotIds, target.orderedSlotIds)) {
      throw new Error("KEY_POOL_LAYOUT_PREFIX_REQUIRED");
    }
    for (
      let index = storedLayout.orderedSlotIds.length;
      index < target.orderedSlotIds.length;
      index += 1
    ) {
      const slotId = target.orderedSlotIds[index] as string;
      sql.exec(SEED_SLOT, slotId, index + 1);
    }
    sql.exec(
      "UPDATE pool_manifest SET layout_id = ?, updated_at = ? WHERE singleton = 1",
      target.layoutId,
      now,
    );
  });
}

function initializeEmptyVersionedPool(
  sql: SqlStorage,
  now: number,
  configuration: KeyPoolPersistenceConfiguration,
): void {
  for (const [index, slotId] of configuration.targetLayout.orderedSlotIds.entries()) {
    sql.exec(SEED_SLOT, slotId, index + 1);
  }
  const firstSlotId = configuration.targetLayout.orderedSlotIds[0] as string;
  sql.exec(
    "INSERT INTO pool_state (singleton, cursor_slot_id, updated_at) VALUES (1, ?, ?)",
    firstSlotId,
    now,
  );
  sql.exec(
    `INSERT INTO pool_manifest (singleton, generation_id, layout_id, updated_at)
     VALUES (1, ?, ?, ?)`,
    configuration.generation.generationId,
    configuration.targetLayout.layoutId,
    now,
  );
  for (const version of [1, 2, 3]) {
    sql.exec(
      "INSERT INTO _key_pool_schema_migrations (version, applied_at) VALUES (?, ?)",
      version,
      now,
    );
  }
}

function assertStoredLayout(
  sql: SqlStorage,
  storedLayout: KeyPoolLayoutDefinition,
  catalog: readonly KeySlotCatalogEntry[],
): void {
  const catalogSlotIds = new Set(catalog.map(({ slotId }) => slotId));
  const rows = sql
    .exec<StoredSlotRow>("SELECT slot_id, priority FROM slots ORDER BY priority ASC")
    .toArray();
  if (rows.length !== storedLayout.orderedSlotIds.length) {
    throw new Error("INVALID_STORED_KEY_POOL_LAYOUT");
  }
  for (const [index, row] of rows.entries()) {
    if (
      !catalogSlotIds.has(row.slot_id) ||
      row.priority !== index + 1 ||
      row.slot_id !== storedLayout.orderedSlotIds[index]
    ) {
      throw new Error("INVALID_STORED_KEY_POOL_LAYOUT");
    }
  }
}

function assertStoredCursorAndLease(sql: SqlStorage, orderedSlotIds: readonly string[]): void {
  const cursor = sql
    .exec<Record<string, SqlStorageValue> & { cursor_slot_id: string }>(
      "SELECT cursor_slot_id FROM pool_state WHERE singleton = 1",
    )
    .toArray()[0]?.cursor_slot_id;
  if (cursor === undefined || !orderedSlotIds.includes(cursor)) {
    throw new Error("INVALID_STORED_POOL_CURSOR");
  }
  const leaseSlotId = sql
    .exec<Record<string, SqlStorageValue> & { slot_id: string }>(
      "SELECT slot_id FROM lease WHERE singleton = 1",
    )
    .toArray()[0]?.slot_id;
  if (leaseSlotId !== undefined && !orderedSlotIds.includes(leaseSlotId)) {
    throw new Error("INVALID_STORED_POOL_LEASE");
  }
}

function synchronizeLegacySlots(
  sql: SqlStorage,
  definitions: readonly { readonly slotId: string; readonly priority: number }[],
): void {
  const stored = sql
    .exec<StoredSlotRow>("SELECT slot_id, priority FROM slots ORDER BY priority ASC")
    .toArray();
  if (stored.length > definitions.length) throw new Error("KEY_SLOT_MANIFEST_REMOVAL_UNSUPPORTED");
  for (const [index, row] of stored.entries()) {
    const definition = definitions[index] as { readonly slotId: string; readonly priority: number };
    if (row.slot_id !== definition.slotId || row.priority !== definition.priority) {
      throw new Error("KEY_SLOT_MANIFEST_REORDER_UNSUPPORTED");
    }
  }
  for (const definition of definitions.slice(stored.length)) {
    sql.exec(SEED_SLOT, definition.slotId, definition.priority);
  }
}

function chooseLegacyCursor(
  sql: SqlStorage,
  now: number,
  definitions: readonly { readonly slotId: string; readonly priority: number }[],
): string {
  const slotIds = new Set(definitions.map(({ slotId }) => slotId));
  const liveLease = sql
    .exec<Record<string, SqlStorageValue> & { slot_id: string }>(
      "SELECT slot_id FROM lease WHERE singleton = 1 AND expires_at > ?",
      now,
    )
    .toArray()[0];
  if (liveLease !== undefined && slotIds.has(liveLease.slot_id)) return liveLease.slot_id;

  const slots = sql.exec<LegacySlotRow>("SELECT * FROM slots ORDER BY priority ASC").toArray();
  const currentUsable = slots.find(({ state }) => state === "active" || state === "cooldown");
  if (currentUsable !== undefined && slotIds.has(currentUsable.slot_id)) {
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
    )[0] as LegacySlotRow;
    if (slotIds.has(latest.slot_id)) {
      return nextSlotId(definitions, latest.slot_id);
    }
  }

  return (definitions[0] as { readonly slotId: string }).slotId;
}

function validatePersistenceConfiguration(configuration: KeyPoolPersistenceConfiguration): void {
  const catalogSlotIds = new Set<string>();
  const bindings = new Set<string>();
  for (const entry of configuration.catalog) {
    if (
      !isNonEmptyString(entry.slotId) ||
      !isNonEmptyString(entry.secretBinding) ||
      catalogSlotIds.has(entry.slotId) ||
      bindings.has(entry.secretBinding)
    ) {
      throw new Error("INVALID_KEY_SLOT_CATALOG");
    }
    catalogSlotIds.add(entry.slotId);
    bindings.add(entry.secretBinding);
  }
  if (
    !isNonEmptyString(configuration.generation.generationId) ||
    !isNonEmptyString(configuration.generation.objectName)
  ) {
    throw new Error("INVALID_KEY_POOL_GENERATION");
  }
  const layoutIds = new Set<string>();
  for (const layout of configuration.knownLayouts) {
    validateLayout(layout, catalogSlotIds);
    if (layoutIds.has(layout.layoutId)) throw new Error("INVALID_KEY_POOL_LAYOUT");
    layoutIds.add(layout.layoutId);
  }
  validateLayout(configuration.targetLayout, catalogSlotIds);
  if (configuration.targetLayout.generationId !== configuration.generation.generationId) {
    throw new Error("INVALID_KEY_POOL_GENERATION");
  }
  const registeredTarget = configuration.knownLayouts.find(
    ({ layoutId }) => layoutId === configuration.targetLayout.layoutId,
  );
  if (
    registeredTarget === undefined ||
    registeredTarget.generationId !== configuration.targetLayout.generationId ||
    !sameSlots(registeredTarget.orderedSlotIds, configuration.targetLayout.orderedSlotIds)
  ) {
    throw new Error("INVALID_KEY_POOL_LAYOUT");
  }
  if (
    configuration.preserveLegacySchema !==
    (configuration.targetLayout.layoutId === LEGACY_KEY_POOL_LAYOUT_ID &&
      configuration.generation.generationId === KEY_POOL_GENERATIONS.legacy.generationId)
  ) {
    throw new Error("INVALID_KEY_POOL_SCHEMA_MODE");
  }
}

function validateLayout(layout: KeyPoolLayoutDefinition, catalogSlotIds: ReadonlySet<string>): void {
  if (
    !isNonEmptyString(layout.layoutId) ||
    !isNonEmptyString(layout.generationId) ||
    layout.orderedSlotIds.length === 0 ||
    new Set(layout.orderedSlotIds).size !== layout.orderedSlotIds.length ||
    layout.orderedSlotIds.some((slotId) => !catalogSlotIds.has(slotId))
  ) {
    throw new Error("INVALID_KEY_POOL_LAYOUT");
  }
}

function readSchemaVersion(sql: SqlStorage): number {
  return sql
    .exec<Record<string, SqlStorageValue> & { version: number }>(
      "SELECT COALESCE(MAX(version), 0) AS version FROM _key_pool_schema_migrations",
    )
    .one().version;
}

function readSchemaVersions(sql: SqlStorage): readonly number[] {
  return sql
    .exec<Record<string, SqlStorageValue> & { version: number }>(
      "SELECT version FROM _key_pool_schema_migrations ORDER BY version",
    )
    .toArray()
    .map(({ version }) => version);
}

function readTableNames(sql: SqlStorage): Set<string> {
  return new Set(
    sql
      .exec<Record<string, SqlStorageValue> & { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .toArray()
      .map(({ name }) => name),
  );
}

function isStrictPrefix(previous: readonly string[], next: readonly string[]): boolean {
  return next.length > previous.length && previous.every((slotId, index) => next[index] === slotId);
}

function sameSlots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((slotId, index) => right[index] === slotId);
}

function sameVersions(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((version, index) => right[index] === version);
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}
