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
  readonly predecessorLayoutId: string | null;
  readonly slotIds: readonly string[];
  readonly initialRingOrder: readonly string[];
  readonly insertedBeforeCursorSlotIds: readonly string[];
}

export const KEY_SLOT_CATALOG = [
  { slotId: "key-01", secretBinding: "WIND_API_KEY_01" },
  { slotId: "key-02", secretBinding: "WIND_API_KEY_02" },
  { slotId: "key-03", secretBinding: "WIND_API_KEY_03" },
  { slotId: "key-04", secretBinding: "WIND_API_KEY_04" },
  { slotId: "key-05", secretBinding: "WIND_API_KEY_05" },
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
    predecessorLayoutId: null,
    slotIds: ["key-01", "key-02"],
    initialRingOrder: ["key-01", "key-02"],
    insertedBeforeCursorSlotIds: [],
  },
  "ring-primary-v1": {
    layoutId: "ring-primary-v1",
    generationId: "primary-v2",
    predecessorLayoutId: null,
    slotIds: ["key-03", "key-02", "key-01"],
    initialRingOrder: ["key-03", "key-02", "key-01"],
    insertedBeforeCursorSlotIds: [],
  },
  "ring-primary-v2": {
    layoutId: "ring-primary-v2",
    generationId: "primary-v2",
    predecessorLayoutId: "ring-primary-v1",
    slotIds: ["key-05", "key-04", "key-03", "key-02", "key-01"],
    initialRingOrder: ["key-05", "key-04", "key-03", "key-02", "key-01"],
    insertedBeforeCursorSlotIds: ["key-05", "key-04"],
  },
} as const satisfies Readonly<Record<string, KeyPoolLayoutDefinition>>;

export const LEGACY_KEY_POOL_LAYOUT_ID = "ring-legacy-v1";
export const KEY_POOL_LAYOUT_ID = "ring-primary-v2";

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
  return isSlotId(value) && getKeyPoolConfiguration(layoutId).layout.slotIds.includes(value);
}

export function getKeySlotDefinition(slotId: SlotId): ConfiguredKeySlotDefinition {
  const definition = KEY_SLOT_CATALOG.find((candidate) => candidate.slotId === slotId);
  if (definition === undefined) throw new Error("UNKNOWN_SLOT");
  return definition;
}

export function getKeySlotDefinitions(layoutId: unknown): readonly KeySlotDefinition[] {
  const layout = getKeyPoolConfiguration(layoutId).layout;
  return layout.initialRingOrder.map((slotId, index) => ({
    ...getKeySlotDefinition(slotId as SlotId),
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
  const layouts = Object.values(KEY_POOL_LAYOUTS);
  const layoutIds = new Set(layouts.map(({ layoutId }) => layoutId));
  if (layoutIds.size !== layouts.length) throw new Error("INVALID_KEY_POOL_LAYOUT");
  for (const layout of layouts) {
    if (!generationIds.has(layout.generationId)) throw new Error("INVALID_KEY_POOL_LAYOUT");
    validateLayoutMetadata(layout, layoutIds, isSlotId);
  }
  for (const layout of layouts) validateLayoutEvolution(layout, layouts);
}

export function validateLayoutMetadata(
  layout: KeyPoolLayoutDefinition,
  knownLayoutIds: ReadonlySet<string>,
  isKnownSlotId: (slotId: string) => boolean,
): void {
  const slotIds = layout.slotIds;
  const initialRingOrder = layout.initialRingOrder;
  const insertedSlotIds = layout.insertedBeforeCursorSlotIds;
  if (
    !isNonEmptyString(layout.layoutId) ||
    !isNonEmptyString(layout.generationId) ||
    (layout.predecessorLayoutId !== null &&
      (!isNonEmptyString(layout.predecessorLayoutId) ||
        !knownLayoutIds.has(layout.predecessorLayoutId) ||
        layout.predecessorLayoutId === layout.layoutId)) ||
    !Array.isArray(slotIds) ||
    hasNoSlots(slotIds) ||
    new Set(slotIds).size !== slotIds.length ||
    slotIds.some((slotId) => !isNonEmptyString(slotId) || !isKnownSlotId(slotId)) ||
    !Array.isArray(initialRingOrder) ||
    !sameMembers(slotIds, initialRingOrder) ||
    !Array.isArray(insertedSlotIds) ||
    new Set(insertedSlotIds).size !== insertedSlotIds.length ||
    insertedSlotIds.some(
      (slotId) => !isNonEmptyString(slotId) || !slotIds.includes(slotId),
    ) ||
    (layout.predecessorLayoutId === null
      ? insertedSlotIds.length !== 0
      : insertedSlotIds.length === 0)
  ) {
    throw new Error("INVALID_KEY_POOL_LAYOUT");
  }
}

export function validateLayoutEvolution(
  layout: KeyPoolLayoutDefinition,
  knownLayouts: readonly KeyPoolLayoutDefinition[],
): void {
  if (layout.predecessorLayoutId === null) return;
  const predecessor = knownLayouts.find(
    ({ layoutId }) => layoutId === layout.predecessorLayoutId,
  );
  if (
    predecessor === undefined ||
    predecessor.generationId !== layout.generationId ||
    layout.slotIds.length !==
      predecessor.slotIds.length + layout.insertedBeforeCursorSlotIds.length ||
    predecessor.slotIds.some((slotId) => !layout.slotIds.includes(slotId)) ||
    layout.insertedBeforeCursorSlotIds.some((slotId) => predecessor.slotIds.includes(slotId)) ||
    !sameSlots(layout.initialRingOrder, [
      ...layout.insertedBeforeCursorSlotIds,
      ...predecessor.initialRingOrder,
    ])
  ) {
    throw new Error("INVALID_KEY_POOL_LAYOUT");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNoSlots(slotIds: readonly string[]): boolean {
  return slotIds.length === 0;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(right).size === right.length &&
    left.every((slotId) => right.includes(slotId))
  );
}

function sameSlots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((slotId, index) => right[index] === slotId);
}
