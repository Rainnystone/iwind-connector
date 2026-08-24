export { KeyPool } from "./key-pool/key-pool";
export { McpApiHandler } from "./mcp/api-handler";

export default {
  fetch(request: Request): Promise<Response> {
    const status = new URL(request.url).pathname === "/mcp" ? 403 : 404;
    return Promise.resolve(new Response(status === 403 ? "Forbidden" : "Not Found", { status }));
  },
} satisfies ExportedHandler;
