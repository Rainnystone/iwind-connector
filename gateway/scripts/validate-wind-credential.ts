import { UPSTREAMS } from "../src/config/upstreams";
import {
  getKeySlotDefinition,
  isSlotId,
  type SlotId,
  type WindSecretBindingName,
} from "../src/key-pool/slots";
import {
  createWindSessionFactory,
  type WindSession,
} from "../src/upstream/session";

const REPRESENTATIVE_TOOL = "get_stock_price_indicators";
const REPRESENTATIVE_INPUT = { windcode: "600519.SH" } as const;

export interface CredentialValidatorDependencies {
  readonly getCredential: (binding: WindSecretBindingName) => string | undefined;
  readonly createSession: (apiKey: string) => Promise<Pick<WindSession, "callTool" | "close">>;
}

type CredentialResponseShape = Readonly<{
  type: "object" | "array" | "primitive";
  keys?: readonly string[];
  contentCount?: number;
  contentTypes?: readonly string[];
}>;

export type CredentialValidationResult =
  | {
      readonly slot: SlotId;
      readonly status: "success";
      readonly responseShape: CredentialResponseShape;
    }
  | { readonly slot: SlotId | "unknown"; readonly status: "failure" };

export async function validateWindCredential(
  requestedSlot: unknown,
  dependencies: CredentialValidatorDependencies,
): Promise<CredentialValidationResult> {
  if (!isSlotId(requestedSlot)) return { slot: "unknown", status: "failure" };
  const credential = dependencies.getCredential(getKeySlotDefinition(requestedSlot).secretBinding);
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return { slot: requestedSlot, status: "failure" };
  }

  let session: Pick<WindSession, "callTool" | "close"> | undefined;
  try {
    session = await dependencies.createSession(credential);
    const result = await session.callTool(REPRESENTATIVE_TOOL, REPRESENTATIVE_INPUT);
    if (isToolError(result)) return { slot: requestedSlot, status: "failure" };
    return { slot: requestedSlot, status: "success", responseShape: summarizeShape(result) };
  } catch {
    return { slot: requestedSlot, status: "failure" };
  } finally {
    try {
      await session?.close();
    } catch {
      // The externally visible result remains a fail-closed anonymous failure.
    }
  }
}

function summarizeShape(value: unknown): CredentialResponseShape {
  if (Array.isArray(value)) return { type: "array" };
  if (!isRecord(value)) return { type: "primitive" };
  const content = Array.isArray(value.content) ? value.content : [];
  return {
    type: "object",
    keys: Object.keys(value).sort(),
    contentCount: content.length,
    contentTypes: [...new Set(content.map(contentType))].sort(),
  };
}

function contentType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
}

function isToolError(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequestedSlot(args: readonly string[]): unknown {
  return args.length === 2 && args[0] === "--slot" ? args[1] : undefined;
}

async function main(): Promise<void> {
  const result = await validateWindCredential(parseRequestedSlot(process.argv.slice(2)), {
    getCredential: (binding) => process.env[binding],
    createSession: (apiKey) => createWindSessionFactory().connect(UPSTREAMS.stock_data, apiKey),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "failure") process.exitCode = 1;
}

if (import.meta.main) void main();
