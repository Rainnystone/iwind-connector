import { describe, expect, it } from "vitest";

import {
  getKeySlotDefinition,
  isSlotId,
  KEY_SLOT_DEFINITIONS,
} from "../../src/key-pool/slots";
import { nextSlotId, orderSlotRing } from "../../src/key-pool/slot-ring";

describe("key slot manifest", () => {
  it("defines the current two-slot deployment contract exactly once", () => {
    expect(KEY_SLOT_DEFINITIONS).toEqual([
      { slotId: "key-01", priority: 1, secretBinding: "WIND_API_KEY_01" },
      { slotId: "key-02", priority: 2, secretBinding: "WIND_API_KEY_02" },
    ]);
  });

  it("keeps priorities contiguous and bindings unique", () => {
    expect(KEY_SLOT_DEFINITIONS.map(({ priority }) => priority)).toEqual([1, 2]);
    expect(new Set(KEY_SLOT_DEFINITIONS.map(({ slotId }) => slotId)).size).toBe(
      KEY_SLOT_DEFINITIONS.length,
    );
    expect(new Set(KEY_SLOT_DEFINITIONS.map(({ secretBinding }) => secretBinding)).size).toBe(
      KEY_SLOT_DEFINITIONS.length,
    );
  });

  it("recognizes every manifest slot and rejects values outside it", () => {
    for (const definition of KEY_SLOT_DEFINITIONS) {
      expect(isSlotId(definition.slotId)).toBe(true);
      expect(getKeySlotDefinition(definition.slotId)).toBe(definition);
    }
    expect(isSlotId("key-03")).toBe(false);
    expect(isSlotId(1)).toBe(false);
    expect(() => Reflect.apply(getKeySlotDefinition, undefined, ["key-03"])).toThrow(
      "UNKNOWN_SLOT",
    );
  });
});

describe("generic slot ring", () => {
  it.each([1, 2, 3, 4])("orders and wraps a %i-slot manifest from every cursor", (size) => {
    const definitions = Array.from({ length: size }, (_, index) => ({
      slotId: `slot-${String(index + 1)}`,
      priority: index + 1,
    }));

    for (let cursorIndex = 0; cursorIndex < size; cursorIndex += 1) {
      const cursor = definitions[cursorIndex];
      if (cursor === undefined) throw new Error("fixture-cursor-missing");
      const expected = [
        ...definitions.slice(cursorIndex),
        ...definitions.slice(0, cursorIndex),
      ].map(({ slotId }) => slotId);

      expect(orderSlotRing(definitions, cursor.slotId).map(({ slotId }) => slotId)).toEqual(
        expected,
      );
      expect(nextSlotId(definitions, cursor.slotId)).toBe(
        definitions[(cursorIndex + 1) % size]?.slotId,
      );
    }
  });

  it("rejects an empty, duplicate, non-contiguous, or unknown-cursor ring", () => {
    expect(() => orderSlotRing([], "slot-1")).toThrow("INVALID_SLOT_RING");
    expect(() =>
      orderSlotRing(
        [
          { slotId: "slot-1", priority: 1 },
          { slotId: "slot-1", priority: 2 },
        ],
        "slot-1",
      ),
    ).toThrow("INVALID_SLOT_RING");
    expect(() =>
      orderSlotRing(
        [
          { slotId: "slot-1", priority: 1 },
          { slotId: "slot-2", priority: 3 },
        ],
        "slot-1",
      ),
    ).toThrow("INVALID_SLOT_RING");
    expect(() => orderSlotRing([{ slotId: "slot-1", priority: 1 }], "slot-2")).toThrow(
      "UNKNOWN_CURSOR_SLOT",
    );
  });
});
