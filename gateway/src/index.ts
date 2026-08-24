import { createOAuthProvider, runOAuthCleanup } from "./auth/provider";

export { KeyPool } from "./key-pool/key-pool";
export { McpApiHandler } from "./mcp/api-handler";

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    return createOAuthProvider(env.PUBLIC_ORIGIN, env.DEPLOYMENT_STAGE).fetch(request, env, ctx);
  },
  scheduled(_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runOAuthCleanup(env));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
