import { XMcpAgent } from "./agent.js";
import { TokenStore } from "./token-store.js";
import { verifyAccess } from "./access.js";

export { XMcpAgent, TokenStore };

const mcpHandler = XMcpAgent.serve("/mcp");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      // Defense in depth: re-verify the Cloudflare Access JWT in-Worker rather
      // than trusting the edge alone. No-op when Access isn't configured.
      const access = await verifyAccess(request, env);
      if (!access.ok) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            event: "access_denied",
            reason: access.reason,
          }),
        );
        return new Response("forbidden", { status: access.status ?? 403 });
      }
      return mcpHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const id = env.TOKEN_STORE.idFromName("singleton");
    const stub = env.TOKEN_STORE.get(id) as unknown as {
      refresh(): Promise<{ refreshed: boolean; expiresAt: number }>;
    };
    try {
      const result = await stub.refresh();
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          event: "cron_refresh",
          refreshed: result.refreshed,
          expires_at: new Date(result.expiresAt).toISOString(),
        }),
      );
    } catch (err) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          event: "cron_refresh_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
