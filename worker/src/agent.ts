import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOLS, type ToolDef } from "./tools.gen.js";

const BODY_KEY = "body";

export class XMcpAgent extends McpAgent<Env> {
  server = new McpServer({ name: "xmcp", version: "2.0.0" });

  async init(): Promise<void> {
    for (const tool of TOOLS) {
      this.registerTool(tool);
    }
  }

  private registerTool(tool: ToolDef): void {
    const inputShape: Record<string, z.ZodTypeAny> = {};
    for (const param of tool.parameters) {
      inputShape[param.name] = param.schema;
    }
    if (tool.requestBody) {
      inputShape[BODY_KEY] = tool.requestBody.schema;
    }

    this.server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputShape,
      },
      async (args: Record<string, unknown>) => {
        return await this.callXApi(tool, args);
      },
    );
  }

  private async callXApi(
    tool: ToolDef,
    args: Record<string, unknown>,
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    const start = Date.now();
    let url = `${this.env.X_API_BASE_URL}${tool.path}`;
    const queryPairs: [string, string][] = [];

    for (const param of tool.parameters) {
      const value = args[param.name];
      if (value === undefined || value === null) continue;
      const encoded = encodeParam(value);
      if (param.in === "path") {
        url = url.replace(`{${param.name}}`, encodeURIComponent(encoded));
      } else if (param.in === "query") {
        queryPairs.push([param.name, encoded]);
      }
    }

    if (queryPairs.length > 0) {
      const qs = queryPairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      url += (url.includes("?") ? "&" : "?") + qs;
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    let body: string | undefined;
    if (tool.requestBody && args[BODY_KEY] !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(args[BODY_KEY]);
    }

    const token = await this.getToken();
    headers["Authorization"] = `Bearer ${token}`;

    const resp = await fetch(url, {
      method: tool.method,
      headers,
      body,
    });

    const text = await resp.text();
    const duration = Date.now() - start;

    this.logRequest({
      tool: tool.name,
      method: tool.method,
      args,
      x_status: resp.status,
      duration_ms: duration,
      ok: resp.ok,
    });

    if (!resp.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `HTTP ${resp.status}: ${text}` }],
      };
    }

    return {
      content: [{ type: "text", text }],
    };
  }

  private async getToken(): Promise<string> {
    const id = this.env.TOKEN_STORE.idFromName("singleton");
    const stub = this.env.TOKEN_STORE.get(id) as unknown as {
      getValidToken(): Promise<string>;
    };
    return await stub.getValidToken();
  }

  private logRequest(entry: {
    tool: string;
    method: string;
    args: Record<string, unknown>;
    x_status: number;
    duration_ms: number;
    ok: boolean;
  }): void {
    const logRaw = this.env.XMCP_LOG_RAW_ARGS === "1";
    const argsField = logRaw
      ? entry.args
      : { keys: Object.keys(entry.args), hash: hashArgs(entry.args) };
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: entry.ok ? "info" : "warn",
        tool: entry.tool,
        method: entry.method,
        args: argsField,
        x_status: entry.x_status,
        duration_ms: entry.duration_ms,
      }),
    );
  }
}

function encodeParam(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function hashArgs(args: Record<string, unknown>): string {
  const normalized = JSON.stringify(args, Object.keys(args).sort());
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
