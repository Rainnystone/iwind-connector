import { getKeySlotDefinition } from "../key-pool/slots";
import type { SlotId } from "../key-pool/types";

import type { InvocationEnvironment } from "./types";

export class MissingWindSecretError extends Error {
  constructor(readonly slotId: SlotId) {
    super("WIND_SECRET_MISSING");
    this.name = "MissingWindSecretError";
  }
}

export function resolveWindSecret(env: InvocationEnvironment, slotId: SlotId): string {
  const definition = getKeySlotDefinition(slotId);
  return requireWindSecret(env[definition.secretBinding], slotId);
}

function requireWindSecret(value: string | undefined, slotId: SlotId): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MissingWindSecretError(slotId);
  }
  return value;
}
