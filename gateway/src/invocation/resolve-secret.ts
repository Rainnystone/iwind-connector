import type { SlotId } from "../key-pool/types";

import type { InvocationEnvironment } from "./types";

export class MissingWindSecretError extends Error {
  constructor(readonly slotId: SlotId) {
    super("WIND_SECRET_MISSING");
    this.name = "MissingWindSecretError";
  }
}

export const WIND_SECRET_SLOT_CONTRACT = {
  "key-01": true,
  "key-02": true,
} as const satisfies Readonly<Record<SlotId, true>>;

export function resolveWindSecret(env: InvocationEnvironment, slotId: SlotId): string {
  switch (slotId) {
    case "key-01":
      return requireWindSecret(env.WIND_API_KEY_01, slotId);
    case "key-02":
      return requireWindSecret(env.WIND_API_KEY_02, slotId);
    default:
      return assertNever(slotId);
  }
}

function requireWindSecret(value: string | undefined, slotId: SlotId): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MissingWindSecretError(slotId);
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`WIND_SECRET_SLOT_UNKNOWN:${String(value)}`);
}
