interface Env {
  TOKEN_STORE: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  X_API_BASE_URL: string;
  XMCP_LOG_RAW_ARGS: string;
  X_OAUTH2_CLIENT_ID: string;
  X_OAUTH2_CLIENT_SECRET: string;
  X_OAUTH2_ACCESS_TOKEN?: string;
  X_OAUTH2_REFRESH_TOKEN?: string;
}
