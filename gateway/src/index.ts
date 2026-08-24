export { KeyPool } from "./key-pool/key-pool";

export default {
  fetch(): Promise<Response> {
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  },
} satisfies ExportedHandler;
