export default {
  fetch(): Promise<Response> {
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  },
} satisfies ExportedHandler;
