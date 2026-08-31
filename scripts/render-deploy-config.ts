import { readFile } from "node:fs/promises";
import path from "node:path";

import { KEY_SLOT_DEFINITIONS } from "../gateway/src/key-pool/slots.js";
import { safeAtomicWrite } from "./safe-atomic-write.js";

type Inputs = Readonly<{
  oauthKvId: string;
  workerName: string;
  publicOrigin: string;
  deploymentStage: "local" | "staging" | "production";
}>;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(REPO_ROOT, "gateway", "wrangler.jsonc");
const OUTPUT_DIRECTORY = path.join(REPO_ROOT, "dist");
const OUTPUT = path.join(OUTPUT_DIRECTORY, "wrangler.deploy.jsonc");

function parseArgs(args: ReadonlyArray<string>): Inputs {
  const values = new Map<string, string>();
  const allowed = new Set(["--oauth-kv-id", "--worker-name", "--public-origin", "--deployment-stage"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !allowed.has(flag) || values.has(flag)) {
      throw new Error("DEPLOY_CONFIG_INVALID");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) throw new Error("DEPLOY_CONFIG_INVALID");

  const oauthKvId = values.get("--oauth-kv-id") ?? "";
  const workerName = values.get("--worker-name") ?? "";
  const publicOrigin = values.get("--public-origin") ?? "";
  const stage = values.get("--deployment-stage") ?? "";
  if (!/^[a-f0-9]{32}$/u.test(oauthKvId) || /^0{32}$/u.test(oauthKvId)) {
    throw new Error("DEPLOY_CONFIG_INVALID");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(workerName)) {
    throw new Error("DEPLOY_CONFIG_INVALID");
  }
  if (stage !== "local" && stage !== "staging" && stage !== "production") {
    throw new Error("DEPLOY_CONFIG_INVALID");
  }
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (stage === "production" && origin.protocol !== "https:")) {
    throw new Error("DEPLOY_CONFIG_INVALID");
  }
  return { oauthKvId, workerName, publicOrigin, deploymentStage: stage };
}
async function render(inputs: Inputs): Promise<void> {
  const source = JSON.parse(await readFile(SOURCE, "utf8")) as Record<string, unknown>;
  const vars = source.vars;
  const namespaces = source.kv_namespaces;
  const secrets = source.secrets;
  const requiredSecrets =
    typeof secrets === "object" && secrets !== null ? Reflect.get(secrets, "required") : null;
  if (
    typeof vars !== "object" ||
    vars === null ||
    !Array.isArray(namespaces) ||
    namespaces.length !== 1 ||
    typeof namespaces[0] !== "object" ||
    namespaces[0] === null ||
    Reflect.get(namespaces[0], "binding") !== "OAUTH_KV" ||
    !Array.isArray(requiredSecrets) ||
    !requiredSecrets.every((binding): binding is string => typeof binding === "string") ||
    !arraysEqual(
      requiredSecrets.filter((binding) => binding.startsWith("WIND_API_KEY_")),
      KEY_SLOT_DEFINITIONS.map(({ secretBinding }) => secretBinding),
    )
  ) {
    throw new Error("DEPLOY_CONFIG_INVALID");
  }
  const rendered = {
    ...source,
    name: inputs.workerName,
    main: "../gateway/src/index.ts",
    vars: { PUBLIC_ORIGIN: inputs.publicOrigin, DEPLOYMENT_STAGE: inputs.deploymentStage },
    kv_namespaces: [{ binding: "OAUTH_KV", id: inputs.oauthKvId }],
  };
  await safeAtomicWrite({
    target: OUTPUT,
    expectedTarget: OUTPUT,
    allowedDirectory: OUTPUT_DIRECTORY,
    protectedPaths: [SOURCE, path.dirname(SOURCE)],
    data: `${JSON.stringify(rendered, null, 2)}\n`,
  });
  process.stdout.write("DEPLOY_CONFIG_OK dist/wrangler.deploy.jsonc\n");
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

try {
  await render(parseArgs(process.argv.slice(2)));
} catch {
  process.stderr.write("DEPLOY_CONFIG_INVALID\n");
  process.exitCode = 1;
}
