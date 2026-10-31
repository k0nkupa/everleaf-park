import handler from "vinext/server/fetch-handler";
import api from "../src/server.ts";
import { runtime } from "../src/runtime.ts";

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/media/")
    ) {
      return runtime.run({ env, ctx, origin: url.origin, request }, () =>
        api.fetch!(request, env, ctx),
      );
    }
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
