export interface RingSlotDefinition {
  readonly slotId: string;
  readonly priority: number;
}

export function orderSlotRing<const Definition extends RingSlotDefinition>(
  definitions: readonly Definition[],
  cursorSlotId: string,
): readonly Definition[] {
  const ordered = [...definitions].sort((left, right) => left.priority - right.priority);
  const slotIds = new Set<string>();
  if (
    ordered.length === 0 ||
    ordered.some((definition, index) => {
      if (definition.priority !== index + 1 || slotIds.has(definition.slotId)) return true;
      slotIds.add(definition.slotId);
      return false;
    })
  ) {
    throw new Error("INVALID_SLOT_RING");
  }

  const cursorIndex = ordered.findIndex(({ slotId }) => slotId === cursorSlotId);
  if (cursorIndex < 0) throw new Error("UNKNOWN_CURSOR_SLOT");
  return [...ordered.slice(cursorIndex), ...ordered.slice(0, cursorIndex)];
}

export function nextSlotId(
  definitions: readonly RingSlotDefinition[],
  cursorSlotId: string,
): string {
  const ordered = orderSlotRing(definitions, cursorSlotId);
  const next = ordered[1] ?? ordered[0];
  if (next === undefined) throw new Error("INVALID_SLOT_RING");
  return next.slotId;
}
