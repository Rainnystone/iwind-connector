import { createOAuthProvider, runOAuthCleanup } from "./auth/provider";
import { enforceOAuthProviderBodyLimit } from "./auth/oauth-body-limits";

export { KeyPool } from "./key-pool/key-pool";
export { McpApiHandler } from "./mcp/api-handler";

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const bounded = await enforceOAuthProviderBodyLimit(request);
    if (bounded instanceof Response) return bounded;
    return createOAuthProvider(env.PUBLIC_ORIGIN, env.DEPLOYMENT_STAGE).fetch(bounded, env, ctx);
  },
  scheduled(_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runOAuthCleanup(env));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
