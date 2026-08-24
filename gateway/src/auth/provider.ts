import {
  OAuthProvider,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";

import { handleAdminRequest } from "../admin/handler";
import { McpApiHandler } from "../mcp/api-handler";
import {
  handleAuthorizationRequest,
  type IWindAuthorizationEnvironment,
} from "./authorization-handler";

export function createOAuthProvider(
  publicOrigin: string,
  deploymentStage: "local" | "staging" | "production" = "production",
): OAuthProvider<Cloudflare.Env> {
  return new OAuthProvider(createOAuthProviderOptions(publicOrigin, deploymentStage));
}

export function createOAuthProviderOptions(
  publicOrigin: string,
  deploymentStage: "local" | "staging" | "production" = "production",
): OAuthProviderOptions<Cloudflare.Env> {
  const issuer = validatePublicOrigin(publicOrigin, deploymentStage);
  return {
    apiRoute: "/mcp",
    apiHandler: McpApiHandler,
    defaultHandler: authorizationAndAdminHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["mcp:read"],
    resourceMetadata: {
      resource: `${issuer}/mcp`,
      ...(issuer.startsWith("https://") ? { authorization_servers: [issuer] } : {}),
      scopes_supported: ["mcp:read"],
      bearer_methods_supported: ["header"],
      resource_name: "iWind AIFin MCP",
    },
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    allowTokenExchangeGrant: false,
  };
}

const authorizationAndAdminHandler = {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/admin/")) return handleAdminRequest(request, env);
    if (pathname !== "/authorize" && pathname !== "/callback") {
      return new Response("Not Found", { status: 404 });
    }
    const helpers = readOAuthHelpers(env);
    if (helpers === null) return new Response("Authorization unavailable", { status: 500 });
    const authorizationEnv: IWindAuthorizationEnvironment = {
      PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
      COOKIE_ENCRYPTION_KEY: env.COOKIE_ENCRYPTION_KEY,
      ACCESS_CLIENT_ID: env.ACCESS_CLIENT_ID,
      ACCESS_CLIENT_SECRET: env.ACCESS_CLIENT_SECRET,
      ACCESS_AUTHORIZATION_URL: env.ACCESS_AUTHORIZATION_URL,
      ACCESS_TOKEN_URL: env.ACCESS_TOKEN_URL,
      ACCESS_JWKS_URL: env.ACCESS_JWKS_URL,
      ACCESS_ISSUER: env.ACCESS_ISSUER,
      ACCESS_AUDIENCE: env.ACCESS_AUDIENCE,
      ALLOWED_USER_EMAIL: env.ALLOWED_USER_EMAIL,
      KEY_POOL: env.KEY_POOL,
      OAUTH_PROVIDER: helpers,
    };
    return handleAuthorizationRequest(request, authorizationEnv);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

function validatePublicOrigin(
  publicOrigin: string,
  deploymentStage: "local" | "staging" | "production",
): string {
  const url = new URL(publicOrigin);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error("PUBLIC_ORIGIN_INVALID");
  }
  const localHttp = deploymentStage === "local" && url.protocol === "http:" && url.hostname === "localhost";
  if (url.protocol !== "https:" && !localHttp) throw new Error("PUBLIC_ORIGIN_INVALID");
  if (deploymentStage !== "local" && url.protocol !== "https:") throw new Error("PUBLIC_ORIGIN_INVALID");
  return url.origin;
}

export async function runOAuthCleanup(
  env: Cloudflare.Env,
  sink: (serialized: string) => void = console.log,
): Promise<void> {
  const result = await createOAuthProvider(env.PUBLIC_ORIGIN, env.DEPLOYMENT_STAGE).purgeExpiredData(
    env,
    { batchSize: 50 },
  );
  sink(
    JSON.stringify({
      event: "oauth_cleanup",
      grantsChecked: result.grantsChecked,
      grantsPurged: result.grantsPurged,
      tokensChecked: result.tokensChecked,
      tokensPurged: result.tokensPurged,
      done: result.done,
    }),
  );
}

function readOAuthHelpers(env: Cloudflare.Env): OAuthHelpers | null {
  const candidate: unknown = Reflect.get(env, "OAUTH_PROVIDER");
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  return typeof record.parseAuthRequest === "function" &&
    typeof record.lookupClient === "function" &&
    typeof record.completeAuthorization === "function"
    ? (candidate as OAuthHelpers)
    : null;
}
