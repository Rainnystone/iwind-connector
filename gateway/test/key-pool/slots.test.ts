import { describe, expect, it } from "vitest";

import {
  assertKeySlotCatalogAppendOnly,
  getKeyPoolConfiguration,
  getKeySlotDefinition,
  getKeySlotDefinitions,
  isSlotId,
  KEY_POOL_GENERATIONS,
  KEY_POOL_LAYOUT_ID,
  KEY_POOL_LAYOUTS,
  KEY_SLOT_CATALOG,
  KEY_SLOT_DEFINITIONS,
  type KeyPoolLayoutDefinition,
} from "../../src/key-pool/slots";
import { nextSlotId, orderSlotRing } from "../../src/key-pool/slot-ring";

describe("key slot manifest", () => {
  it("keeps a unique append-only catalog and derives the primary ring from it", () => {
    expect(KEY_SLOT_CATALOG).toEqual([
      { slotId: "key-01", secretBinding: "WIND_API_KEY_01" },
      { slotId: "key-02", secretBinding: "WIND_API_KEY_02" },
      { slotId: "key-03", secretBinding: "WIND_API_KEY_03" },
      { slotId: "key-04", secretBinding: "WIND_API_KEY_04" },
      { slotId: "key-05", secretBinding: "WIND_API_KEY_05" },
    ]);
    expect(getKeySlotDefinitions(KEY_POOL_LAYOUT_ID)).toEqual([
      { slotId: "key-05", priority: 1, secretBinding: "WIND_API_KEY_05" },
      { slotId: "key-04", priority: 2, secretBinding: "WIND_API_KEY_04" },
      { slotId: "key-03", priority: 3, secretBinding: "WIND_API_KEY_03" },
      { slotId: "key-02", priority: 4, secretBinding: "WIND_API_KEY_02" },
      { slotId: "key-01", priority: 5, secretBinding: "WIND_API_KEY_01" },
    ]);
    expect(KEY_SLOT_DEFINITIONS).toEqual(getKeySlotDefinitions("ring-legacy-v1"));
  });

  it("declares the five stable slots and the cursor-relative primary v2 insertion", () => {
    expect(KEY_SLOT_CATALOG).toEqual([
      { slotId: "key-01", secretBinding: "WIND_API_KEY_01" },
      { slotId: "key-02", secretBinding: "WIND_API_KEY_02" },
      { slotId: "key-03", secretBinding: "WIND_API_KEY_03" },
      { slotId: "key-04", secretBinding: "WIND_API_KEY_04" },
      { slotId: "key-05", secretBinding: "WIND_API_KEY_05" },
    ]);
    expect(getKeyPoolConfiguration("ring-primary-v1").layout).toMatchObject({
      predecessorLayoutId: null,
      slotIds: ["key-03", "key-02", "key-01"],
      initialRingOrder: ["key-03", "key-02", "key-01"],
      insertedBeforeCursorSlotIds: [],
    });
    expect(getKeyPoolConfiguration("ring-primary-v2").layout).toEqual({
      layoutId: "ring-primary-v2",
      generationId: "primary-v2",
      predecessorLayoutId: "ring-primary-v1",
      slotIds: ["key-05", "key-04", "key-03", "key-02", "key-01"],
      initialRingOrder: ["key-05", "key-04", "key-03", "key-02", "key-01"],
      insertedBeforeCursorSlotIds: ["key-05", "key-04"],
    });
    expect(KEY_POOL_LAYOUT_ID).toBe("ring-primary-v2");
    expect(getKeySlotDefinitions(KEY_POOL_LAYOUT_ID).map(({ slotId }) => slotId)).toEqual([
      "key-05",
      "key-04",
      "key-03",
      "key-02",
      "key-01",
    ]);
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
      layoutId: "ring-primary-v2",
      generationId: "primary-v2",
      predecessorLayoutId: "ring-primary-v1",
      slotIds: ["key-05", "key-04", "key-03", "key-02", "key-01"],
      initialRingOrder: ["key-05", "key-04", "key-03", "key-02", "key-01"],
      insertedBeforeCursorSlotIds: ["key-05", "key-04"],
    });
    expect(configuration.generation).toEqual({
      generationId: "primary-v2",
      objectName: "private-key-pool-v2",
    });
    for (const catalogEntry of KEY_SLOT_CATALOG) {
      expect(isSlotId(catalogEntry.slotId)).toBe(true);
      expect(getKeySlotDefinition(catalogEntry.slotId)).toBe(catalogEntry);
    }
    expect(isSlotId("key-04")).toBe(true);
    expect(isSlotId(1)).toBe(false);
    expect(() => Reflect.apply(getKeySlotDefinition, undefined, ["key-06"])).toThrow(
      "UNKNOWN_SLOT",
    );
    expect(() => getKeyPoolConfiguration("ring-unknown-v1")).toThrow("INVALID_KEY_POOL_LAYOUT");
  });

  it("fails closed when two generations reuse one Durable Object name", () => {
    const generations = KEY_POOL_GENERATIONS as unknown as Record<
      string,
      { generationId: string; objectName: string }
    >;
    const layouts = KEY_POOL_LAYOUTS as unknown as Record<
      string,
      {
        layoutId: string;
        generationId: string;
        predecessorLayoutId: null;
        slotIds: readonly ("key-01")[];
        initialRingOrder: readonly ("key-01")[];
        insertedBeforeCursorSlotIds: readonly [];
      }
    >;
    generations.duplicateObjectName = {
      generationId: "duplicate-object-name-v3",
      objectName: "private-key-pool-v2",
    };
    layouts["ring-duplicate-object-name-v1"] = {
      layoutId: "ring-duplicate-object-name-v1",
      generationId: "duplicate-object-name-v3",
      predecessorLayoutId: null,
      slotIds: ["key-01"],
      initialRingOrder: ["key-01"],
      insertedBeforeCursorSlotIds: [],
    };

    try {
      expect(() => getKeyPoolConfiguration("ring-duplicate-object-name-v1")).toThrow(
        "INVALID_KEY_POOL_GENERATION",
      );
    } finally {
      delete layouts["ring-duplicate-object-name-v1"];
      delete generations.duplicateObjectName;
    }
  });

  it("rejects a layout that omits cursor-relative metadata with a deterministic error", () => {
    const layouts = KEY_POOL_LAYOUTS as unknown as Record<string, KeyPoolLayoutDefinition>;
    layouts["ring-malformed-v1"] = {
      layoutId: "ring-malformed-v1",
      generationId: "primary-v2",
      orderedSlotIds: ["key-03", "key-02", "key-01"],
    } as unknown as KeyPoolLayoutDefinition;

    try {
      expect(() => getKeyPoolConfiguration("ring-malformed-v1")).toThrow(
        "INVALID_KEY_POOL_LAYOUT",
      );
    } finally {
      delete layouts["ring-malformed-v1"];
    }
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
