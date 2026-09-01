import type { AcquireLeaseResult, SlotId } from "./types";
import { LEGACY_KEY_POOL_LAYOUT_ID, getKeyPoolConfiguration } from "./slots";

const ACQUIRE_WAIT_MS = 2_000;
const ACQUIRE_POLL_MS = 100;

type KeyPoolEnvironment = Pick<Cloudflare.Env, "KEY_POOL">;

export async function acquireKeyPoolLease(
  env: KeyPoolEnvironment,
  requestId: string,
  attemptedSlotIds: readonly SlotId[] = [],
  objectName = getKeyPoolConfiguration(LEGACY_KEY_POOL_LAYOUT_ID).generation.objectName,
): Promise<AcquireLeaseResult> {
  const keyPool = env.KEY_POOL.getByName(objectName);
  const deadline = Date.now() + ACQUIRE_WAIT_MS;
  let firstAttempt = true;

  while (true) {
    const now = Date.now();
    if (!firstAttempt && now >= deadline) {
      return { ok: false, code: "GATEWAY_BUSY", retryAfterMs: null };
    }
    firstAttempt = false;

    const result = await keyPool.acquireLease({ requestId, attemptedSlotIds, now });
    if (result.ok || result.code === "KEY_POOL_EXHAUSTED") return result;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { ok: false, code: "GATEWAY_BUSY", retryAfterMs: null };
    }
    await wait(Math.min(ACQUIRE_POLL_MS, remainingMs));
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
