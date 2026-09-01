export interface KeySlotCatalogEntry {
  readonly slotId: string;
  readonly secretBinding: string;
}

export interface KeySlotDefinition extends KeySlotCatalogEntry {
  readonly priority: number;
}

export interface KeyPoolGenerationDefinition {
  readonly generationId: string;
  readonly objectName: string;
}

export interface KeyPoolLayoutDefinition {
  readonly layoutId: string;
  readonly generationId: string;
  readonly orderedSlotIds: readonly SlotId[];
}

export const KEY_SLOT_CATALOG = [
  { slotId: "key-01", secretBinding: "WIND_API_KEY_01" },
  { slotId: "key-02", secretBinding: "WIND_API_KEY_02" },
  { slotId: "key-03", secretBinding: "WIND_API_KEY_03" },
] as const satisfies readonly KeySlotCatalogEntry[];

export type SlotId = (typeof KEY_SLOT_CATALOG)[number]["slotId"];
export type WindSecretBindingName = (typeof KEY_SLOT_CATALOG)[number]["secretBinding"];

export const KEY_POOL_GENERATIONS = {
  legacy: { generationId: "legacy-v1", objectName: "private-key-pool" },
  primary: { generationId: "primary-v2", objectName: "private-key-pool-v2" },
} as const satisfies Readonly<Record<string, KeyPoolGenerationDefinition>>;

export const KEY_POOL_LAYOUTS = {
  "ring-legacy-v1": {
    layoutId: "ring-legacy-v1",
    generationId: "legacy-v1",
    orderedSlotIds: ["key-01", "key-02"],
  },
  "ring-primary-v1": {
    layoutId: "ring-primary-v1",
    generationId: "primary-v2",
    orderedSlotIds: ["key-03", "key-02", "key-01"],
  },
} as const satisfies Readonly<Record<string, KeyPoolLayoutDefinition>>;

export const LEGACY_KEY_POOL_LAYOUT_ID = "ring-legacy-v1";
export const KEY_POOL_LAYOUT_ID = "ring-primary-v1";

type ConfiguredKeySlotDefinition = (typeof KEY_SLOT_CATALOG)[number];
type KeyPoolLayoutId = keyof typeof KEY_POOL_LAYOUTS;

validateKeySlotCatalog(KEY_SLOT_CATALOG);
validateKeyPoolDefinitions();

/** Compatibility definition for the unmodified legacy pool. */
export const KEY_SLOT_DEFINITIONS = getKeySlotDefinitions(LEGACY_KEY_POOL_LAYOUT_ID);

export function isSlotId(value: unknown): value is SlotId {
  return (
    typeof value === "string" &&
    KEY_SLOT_CATALOG.some(({ slotId }) => slotId === value)
  );
}

export function isSlotIdInLayout(value: unknown, layoutId: unknown): value is SlotId {
  return isSlotId(value) && getKeyPoolConfiguration(layoutId).layout.orderedSlotIds.includes(value);
}

export function getKeySlotDefinition(slotId: SlotId): ConfiguredKeySlotDefinition {
  const definition = KEY_SLOT_CATALOG.find((candidate) => candidate.slotId === slotId);
  if (definition === undefined) throw new Error("UNKNOWN_SLOT");
  return definition;
}

export function getKeySlotDefinitions(layoutId: unknown): readonly KeySlotDefinition[] {
  const layout = getKeyPoolConfiguration(layoutId).layout;
  return layout.orderedSlotIds.map((slotId, index) => ({
    ...getKeySlotDefinition(slotId),
    priority: index + 1,
  }));
}

export function getKeyPoolConfiguration(layoutId: unknown): Readonly<{
  layout: KeyPoolLayoutDefinition;
  generation: KeyPoolGenerationDefinition;
}> {
  validateKeyPoolDefinitions();
  if (typeof layoutId !== "string" || !Object.hasOwn(KEY_POOL_LAYOUTS, layoutId)) {
    throw new Error("INVALID_KEY_POOL_LAYOUT");
  }
  const layout = KEY_POOL_LAYOUTS[layoutId as KeyPoolLayoutId];
  const generation = Object.values(KEY_POOL_GENERATIONS).find(
    (candidate) => candidate.generationId === layout.generationId,
  );
  if (generation === undefined) throw new Error("INVALID_KEY_POOL_GENERATION");
  return { layout, generation };
}

export function getKeyPoolConfigurationForObject(
  objectName: unknown,
  activeLayoutId: unknown,
): ReturnType<typeof getKeyPoolConfiguration> {
  if (typeof objectName !== "string") throw new Error("INVALID_KEY_POOL_OBJECT");
  const legacy = getKeyPoolConfiguration(LEGACY_KEY_POOL_LAYOUT_ID);
  if (objectName === legacy.generation.objectName) return legacy;
  const active = getKeyPoolConfiguration(activeLayoutId);
  if (objectName !== active.generation.objectName) throw new Error("INVALID_KEY_POOL_OBJECT");
  return active;
}

export function assertKeySlotCatalogAppendOnly(
  previous: readonly KeySlotCatalogEntry[],
  next: readonly KeySlotCatalogEntry[],
): void {
  validateKeySlotCatalog(previous);
  validateKeySlotCatalog(next);
  if (
    next.length < previous.length ||
    previous.some(
      (entry, index) =>
        next[index]?.slotId !== entry.slotId || next[index]?.secretBinding !== entry.secretBinding,
    )
  ) {
    throw new Error("KEY_SLOT_CATALOG_APPEND_ONLY");
  }
}

function validateKeySlotCatalog(catalog: readonly KeySlotCatalogEntry[]): void {
  const slotIds = new Set<string>();
  const secretBindings = new Set<string>();
  for (const { slotId, secretBinding } of catalog) {
    if (
      !isNonEmptyString(slotId) ||
      !isNonEmptyString(secretBinding) ||
      slotIds.has(slotId) ||
      secretBindings.has(secretBinding)
    ) {
      throw new Error("INVALID_KEY_SLOT_CATALOG");
    }
    slotIds.add(slotId);
    secretBindings.add(secretBinding);
  }
}

function validateKeyPoolDefinitions(): void {
  const generationIds = new Set<string>();
  const objectNames = new Set<string>();
  for (const generation of Object.values(KEY_POOL_GENERATIONS)) {
    if (
      !isNonEmptyString(generation.generationId) ||
      !isNonEmptyString(generation.objectName) ||
      generationIds.has(generation.generationId) ||
      objectNames.has(generation.objectName)
    ) {
      throw new Error("INVALID_KEY_POOL_GENERATION");
    }
    generationIds.add(generation.generationId);
    objectNames.add(generation.objectName);
  }
  for (const layout of Object.values(KEY_POOL_LAYOUTS)) {
    if (
      !isNonEmptyString(layout.layoutId) ||
      !generationIds.has(layout.generationId) ||
      hasNoSlots(layout.orderedSlotIds) ||
      new Set(layout.orderedSlotIds).size !== layout.orderedSlotIds.length ||
      layout.orderedSlotIds.some((slotId) => !isSlotId(slotId))
    ) {
      throw new Error("INVALID_KEY_POOL_LAYOUT");
    }
  }
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

function hasNoSlots(slotIds: readonly string[]): boolean {
  return slotIds.length === 0;
}
