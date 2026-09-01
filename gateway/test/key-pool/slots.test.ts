import { describe, expect, it } from "vitest";

import {
  assertKeySlotCatalogAppendOnly,
  getKeyPoolConfiguration,
  getKeySlotDefinition,
  getKeySlotDefinitions,
  isSlotId,
  KEY_POOL_LAYOUT_ID,
  KEY_SLOT_CATALOG,
  KEY_SLOT_DEFINITIONS,
} from "../../src/key-pool/slots";
import { nextSlotId, orderSlotRing } from "../../src/key-pool/slot-ring";

describe("key slot manifest", () => {
  it("keeps a unique append-only catalog and derives the primary ring from it", () => {
    expect(KEY_SLOT_CATALOG).toEqual([
      { slotId: "key-01", secretBinding: "WIND_API_KEY_01" },
      { slotId: "key-02", secretBinding: "WIND_API_KEY_02" },
      { slotId: "key-03", secretBinding: "WIND_API_KEY_03" },
    ]);
    expect(getKeySlotDefinitions(KEY_POOL_LAYOUT_ID)).toEqual([
      { slotId: "key-03", priority: 1, secretBinding: "WIND_API_KEY_03" },
      { slotId: "key-02", priority: 2, secretBinding: "WIND_API_KEY_02" },
      { slotId: "key-01", priority: 3, secretBinding: "WIND_API_KEY_01" },
    ]);
    expect(KEY_SLOT_DEFINITIONS).toEqual(getKeySlotDefinitions("ring-legacy-v1"));
  });

  it("rejects removal, reorder, duplicate slots, and duplicate bindings from catalog growth", () => {
    expect(() => assertKeySlotCatalogAppendOnly(KEY_SLOT_CATALOG, KEY_SLOT_CATALOG.slice(0, 2))).toThrow(
      "KEY_SLOT_CATALOG_APPEND_ONLY",
    );
    expect(() =>
      assertKeySlotCatalogAppendOnly(KEY_SLOT_CATALOG.slice(0, 2), [
        KEY_SLOT_CATALOG[1]!,
        KEY_SLOT_CATALOG[0]!,
      ]),
    ).toThrow("KEY_SLOT_CATALOG_APPEND_ONLY");
    expect(() =>
      assertKeySlotCatalogAppendOnly([], [
        { slotId: "slot-01", secretBinding: "WIND_API_KEY_99" },
        { slotId: "slot-01", secretBinding: "WIND_API_KEY_98" },
      ]),
    ).toThrow("INVALID_KEY_SLOT_CATALOG");
    expect(() =>
      assertKeySlotCatalogAppendOnly([], [
        { slotId: "slot-01", secretBinding: "WIND_API_KEY_99" },
        { slotId: "slot-02", secretBinding: "WIND_API_KEY_99" },
      ]),
    ).toThrow("INVALID_KEY_SLOT_CATALOG");
  });

  it("resolves declared layouts and generations while rejecting unknown layouts", () => {
    const configuration = getKeyPoolConfiguration(KEY_POOL_LAYOUT_ID);
    expect(configuration.layout).toMatchObject({
      layoutId: "ring-primary-v1",
      generationId: "primary-v2",
      orderedSlotIds: ["key-03", "key-02", "key-01"],
    });
    expect(configuration.generation).toEqual({
      generationId: "primary-v2",
      objectName: "private-key-pool-v2",
    });
    for (const catalogEntry of KEY_SLOT_CATALOG) {
      expect(isSlotId(catalogEntry.slotId)).toBe(true);
      expect(getKeySlotDefinition(catalogEntry.slotId)).toBe(catalogEntry);
    }
    expect(isSlotId("key-04")).toBe(false);
    expect(isSlotId(1)).toBe(false);
    expect(() => Reflect.apply(getKeySlotDefinition, undefined, ["key-04"])).toThrow(
      "UNKNOWN_SLOT",
    );
    expect(() => getKeyPoolConfiguration("ring-unknown-v1")).toThrow("INVALID_KEY_POOL_LAYOUT");
  });
});

describe("generic slot ring", () => {
  it.each([1, 2, 3, 4, 5, 8])("orders and wraps a %i-slot manifest from every cursor", (size) => {
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
