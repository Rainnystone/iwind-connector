import { describe, expect, it } from "vitest";

import {
  getKeySlotDefinition,
  isSlotId,
  KEY_SLOT_DEFINITIONS,
} from "../../src/key-pool/slots";

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
