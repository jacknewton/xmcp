# X API MCP Server (Cloudflare Worker)

A Cloudflare Worker that exposes a curated set of X API tools via the Model
Context Protocol. Single-tenant — your X account, your Worker — secured by
Cloudflare Access.

## Architecture

```
Claude Desktop / Claude Code
         │ HTTPS + CF-Access-Client-{Id,Secret}
         ▼
Cloudflare Access (Zero Trust)
         │ verifies, forwards
         ▼
Worker  ──► /mcp  (Streamable HTTP MCP transport)
         │
         ├──► TokenStore  Durable Object  (X access/refresh tokens)
         │           ▲
         │           │ hourly refresh
         │      Cron Trigger
         │
         └──► api.x.com (per-tool-call with fresh bearer token)
```

## Tools

15 tools, generated from X's OpenAPI spec at deploy time:

| Category | Tools |
|----------|-------|
| User | `getUsersMe`, `getUsersByUsername` |
| Bookmarks | `getUsersBookmarks`, `getUsersBookmarkFolders`, `getUsersBookmarksByFolderId`, `createUsersBookmark`, `deleteUsersBookmark` |
| Posts | `createPosts`, `getPostsById`, `getPostsByIds`, `searchPostsRecent`, `getUsersPosts`, `getUsersLikedPosts`, `getUsersMentions` |
| Search | `searchUsers` |

To change the set, edit `worker/scripts/gen-tools.ts` (the `ALLOWLIST` constant)
and re-deploy.

## Setup

### Prerequisites

- Cloudflare account on Workers Paid plan (Durable Objects required)
- Cloudflare Zero Trust team configured
- A Cloudflare-managed DNS zone (the example uses `newton.io`)
- `wrangler` CLI logged in (`wrangler login`)
- An X Developer App with OAuth 2.0 enabled

### One-time

1. Install deps and generate tools:
   ```
   cd worker
   npm install
   npm run gen
   ```

2. Set Worker secrets:
   ```
   wrangler secret put X_OAUTH2_CLIENT_ID
   wrangler secret put X_OAUTH2_CLIENT_SECRET
   wrangler secret put X_OAUTH2_ACCESS_TOKEN     # bootstrap, see below
   wrangler secret put X_OAUTH2_REFRESH_TOKEN    # bootstrap
   ```

   The TokenStore Durable Object reads these secrets the first time it's
   accessed, then persists them in DO storage and self-refreshes from then on.
   The bootstrap secrets become irrelevant after first use.

3. Generate the initial OAuth 2.0 user tokens. Authorize via X with redirect
   URI `http://127.0.0.1:8977/callback`, then exchange the code for tokens.
   Any standard PKCE flow works.

4. Deploy:
   ```
   npm run deploy
   ```

5. In the Cloudflare dashboard:
   - Add `xmcp.<your-zone>` as a custom domain on the Worker.
   - Configure a Zero Trust Access Application targeting the Worker URL.
   - Set the policy to allow your email (or a service token).
   - If using a service token, generate and save the `CF-Access-Client-Id`
     and `CF-Access-Client-Secret`.

### Connect Claude Desktop / Claude Code

Use the `mcp-remote` bridge to connect, passing the Access service token as
custom headers:

```json
{
  "mcpServers": {
    "xmcp": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://xmcp.<your-zone>/mcp",
        "--header", "CF-Access-Client-Id:<id>",
        "--header", "CF-Access-Client-Secret:<secret>"
      ]
    }
  }
}
```

## Development

```
cd worker
npm run gen        # regenerate tools.gen.ts from X OpenAPI
npm run dev        # wrangler dev (loads .dev.vars)
npm run typecheck
npm run tail       # stream logs from production
```

Local dev uses `.dev.vars` (gitignored) — copy from `.dev.vars.example`.

## Logging

Each tool call emits one JSON log line:

```json
{"ts":"...","level":"info","tool":"getUsersMe","method":"GET","args":{"keys":[],"hash":"..."},"x_status":200,"duration_ms":142}
```

Argument values are hashed by default to avoid logging post content. Set the
`XMCP_LOG_RAW_ARGS=1` environment variable to log raw argument values for
debugging.

Cron token refreshes also log:

```json
{"ts":"...","level":"info","event":"cron_refresh","refreshed":true,"expires_at":"..."}
```

Logs are visible via `wrangler tail` and in Cloudflare's Workers Logs (7-day
retention).
