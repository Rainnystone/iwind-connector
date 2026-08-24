import type { SlotId } from "../key-pool/types";

import type { InvocationEnvironment } from "./types";

export class MissingWindSecretError extends Error {
  constructor(readonly slotId: SlotId) {
    super("WIND_SECRET_MISSING");
    this.name = "MissingWindSecretError";
  }
}

export function resolveWindSecret(env: InvocationEnvironment, slotId: SlotId): string {
  let value: string | undefined;
  switch (slotId) {
    case "key-01":
      value = env.WIND_API_KEY_01;
      break;
    case "key-02":
      value = env.WIND_API_KEY_02;
      break;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MissingWindSecretError(slotId);
  }
  return value;
}
