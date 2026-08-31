export interface KeySlotDefinition {
  readonly slotId: string;
  readonly priority: number;
  readonly secretBinding: string;
}

export const KEY_SLOT_DEFINITIONS = [
  { slotId: "key-01", priority: 1, secretBinding: "WIND_API_KEY_01" },
  { slotId: "key-02", priority: 2, secretBinding: "WIND_API_KEY_02" },
] as const satisfies readonly KeySlotDefinition[];

export type SlotId = (typeof KEY_SLOT_DEFINITIONS)[number]["slotId"];
export type WindSecretBindingName =
  (typeof KEY_SLOT_DEFINITIONS)[number]["secretBinding"];

type ConfiguredKeySlotDefinition = (typeof KEY_SLOT_DEFINITIONS)[number];

const SLOT_IDS: ReadonlySet<string> = new Set(
  KEY_SLOT_DEFINITIONS.map(({ slotId }) => slotId),
);

export function isSlotId(value: unknown): value is SlotId {
  return typeof value === "string" && SLOT_IDS.has(value);
}

export function getKeySlotDefinition(slotId: SlotId): ConfiguredKeySlotDefinition {
  const definition = KEY_SLOT_DEFINITIONS.find((candidate) => candidate.slotId === slotId);
  if (definition === undefined) throw new Error("UNKNOWN_SLOT");
  return definition;
}
