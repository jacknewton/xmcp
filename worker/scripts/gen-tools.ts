/**
 * gen-tools.ts — generate `src/tools.gen.ts` from X's OpenAPI spec.
 *
 * Fetches the X API OpenAPI document, keeps only the operations named in
 * ALLOWLIST, and emits a typed `TOOLS` array (Zod input schemas) consumed by
 * `src/agent.ts`. The generated file is a build artifact and is gitignored;
 * this generator is the source of truth.
 *
 * Run with: `npm run gen` (tsx scripts/gen-tools.ts)
 * Override the spec URL with the X_OPENAPI_URL env var.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OPENAPI_URL = process.env.X_OPENAPI_URL ?? "https://api.x.com/2/openapi.json";
const OUTPUT = fileURLToPath(new URL("../src/tools.gen.ts", import.meta.url));

/**
 * The curated set of X API operations exposed as MCP tools. Keys are X
 * OpenAPI `operationId`s. Edit this list and re-run `npm run gen` to change
 * which tools the Worker offers.
 */
const ALLOWLIST: readonly string[] = [
  // User
  "getUsersMe",
  "getUsersByUsername",
  // Bookmarks
  "getUsersBookmarks",
  "getUsersBookmarkFolders",
  "getUsersBookmarksByFolderId",
  "createUsersBookmark",
  "deleteUsersBookmark",
  // Posts
  "createPosts",
  "getPostsById",
  "getPostsByIds",
  "searchPostsRecent",
  "getUsersPosts",
  "getUsersLikedPosts",
  "getUsersMentions",
  // Search
  "searchUsers",
];

// Cap recursion into deeply nested request-body schemas; beyond this we fall
// back to z.any() rather than emit a huge or cyclic schema.
const MAX_DEPTH = 6;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type JsonSchema = Record<string, any>;

interface OpenApiSpec {
  openapi?: string;
  info?: { version?: string };
  paths: Record<string, Record<string, any>>;
  components?: Record<string, any>;
}

async function main(): Promise<void> {
  console.error(`Fetching OpenAPI spec from ${OPENAPI_URL} ...`);
  const resp = await fetch(OPENAPI_URL, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    throw new Error(`Failed to fetch OpenAPI spec: HTTP ${resp.status}`);
  }
  const spec = (await resp.json()) as OpenApiSpec;

  const resolver = makeResolver(spec);
  const wanted = new Set(ALLOWLIST);
  const byId = new Map<string, GeneratedTool>();

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op || typeof op !== "object") continue;
      const opId: string | undefined = op.operationId;
      if (!opId || !wanted.has(opId)) continue;
      byId.set(opId, buildTool(opId, path, method, op, resolver));
    }
  }

  const missing = ALLOWLIST.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Operations not found in OpenAPI spec: ${missing.join(", ")}`);
  }

  // Preserve ALLOWLIST order for stable, readable output.
  const tools = ALLOWLIST.map((id) => byId.get(id)!);
  const file = renderFile(spec, tools);
  writeFileSync(OUTPUT, file, "utf8");
  console.error(`Wrote ${tools.length} tools to ${OUTPUT}`);
}

interface GeneratedTool {
  name: string;
  description: string;
  method: string;
  path: string;
  params: { name: string; in: "path" | "query"; expr: string }[];
  bodyExpr?: string;
}

type Resolver = (node: JsonSchema) => JsonSchema;

function makeResolver(spec: OpenApiSpec): Resolver {
  return function resolve(node: JsonSchema): JsonSchema {
    let current = node;
    const seen = new Set<string>();
    while (current && typeof current.$ref === "string") {
      const ref = current.$ref as string;
      if (seen.has(ref)) return {}; // cycle guard
      seen.add(ref);
      current = derefPointer(spec, ref);
    }
    return current ?? {};
  };
}

function derefPointer(spec: OpenApiSpec, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported external/non-local $ref: ${ref}`);
  }
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: any = spec;
  for (const part of parts) {
    cur = cur?.[part];
    if (cur === undefined) throw new Error(`Could not resolve $ref: ${ref}`);
  }
  return cur as JsonSchema;
}

function buildTool(
  opId: string,
  path: string,
  method: string,
  op: any,
  resolve: Resolver,
): GeneratedTool {
  const params: GeneratedTool["params"] = [];
  for (const rawParam of op.parameters ?? []) {
    const param = resolve(rawParam);
    const loc = param.in;
    if (loc !== "path" && loc !== "query") continue; // header/cookie unsupported
    const schema = resolve(param.schema ?? {});
    const expr = zodExpr(schema, resolve, {
      depth: 0,
      required: Boolean(param.required),
      description: param.description ?? schema.description,
    });
    params.push({ name: param.name, in: loc, expr });
  }

  let bodyExpr: string | undefined;
  const requestBody = op.requestBody ? resolve(op.requestBody) : undefined;
  const jsonContent = requestBody?.content?.["application/json"];
  if (jsonContent?.schema) {
    const schema = resolve(jsonContent.schema);
    bodyExpr = zodExpr(schema, resolve, {
      depth: 0,
      required: Boolean(requestBody.required),
      description: schema.description,
    });
  }

  const description: string =
    op.summary?.trim() || op.description?.trim() || opId;

  return {
    name: opId,
    description,
    method: method.toUpperCase(),
    path,
    params,
    bodyExpr,
  };
}

interface ZodCtx {
  depth: number;
  required: boolean;
  description?: string;
}

/** Convert a (resolved) JSON Schema node into a Zod expression string. */
function zodExpr(schemaIn: JsonSchema, resolve: Resolver, ctx: ZodCtx): string {
  const schema = resolve(schemaIn);
  let base = baseZod(schema, resolve, ctx.depth);

  if (schema.nullable) base += ".nullable()";
  if (ctx.description) base += `.describe(${str(ctx.description)})`;
  if (!ctx.required) base += ".optional()";
  return base;
}

function baseZod(schema: JsonSchema, resolve: Resolver, depth: number): string {
  if (depth >= MAX_DEPTH) return "z.any()";

  // Composition keywords.
  if (Array.isArray(schema.allOf)) {
    return mergeAllOf(schema.allOf, resolve, depth);
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const variants = (schema.oneOf ?? schema.anyOf) as JsonSchema[];
    const exprs = variants.map((v) => baseZod(resolve(v), resolve, depth + 1));
    if (exprs.length === 0) return "z.any()";
    if (exprs.length === 1) return exprs[0]!;
    return `z.union([${exprs.join(", ")}])`;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allStrings = schema.enum.every((v: unknown) => typeof v === "string");
    if (allStrings) {
      return `z.enum([${schema.enum.map((v: string) => str(v)).join(", ")}])`;
    }
    // Mixed/non-string enum: fall through to type handling.
  }

  switch (schema.type) {
    case "string":
      return "z.string()";
    case "integer": {
      let e = "z.number().int()";
      if (typeof schema.minimum === "number") e += `.gte(${schema.minimum})`;
      if (typeof schema.maximum === "number") e += `.lte(${schema.maximum})`;
      return e;
    }
    case "number": {
      let e = "z.number()";
      if (typeof schema.minimum === "number") e += `.gte(${schema.minimum})`;
      if (typeof schema.maximum === "number") e += `.lte(${schema.maximum})`;
      return e;
    }
    case "boolean":
      return "z.boolean()";
    case "array": {
      const items = schema.items ? resolve(schema.items) : {};
      const inner = baseZod(items, resolve, depth + 1);
      return `z.array(${inner})`;
    }
    case "object":
      return objectZod(schema, resolve, depth);
    default:
      // No declared type: object-ish if it has properties, else permissive.
      if (schema.properties) return objectZod(schema, resolve, depth);
      return "z.any()";
  }
}

function objectZod(schema: JsonSchema, resolve: Resolver, depth: number): string {
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);

  if (!props || Object.keys(props).length === 0) {
    // Free-form object (passthrough keeps it valid across zod 3 and 4).
    return "z.object({}).passthrough()";
  }

  const lines: string[] = [];
  for (const [key, rawValue] of Object.entries(props)) {
    const value = resolve(rawValue);
    const expr = zodExpr(value, resolve, {
      depth: depth + 1,
      required: required.has(key),
      description: value.description,
    });
    lines.push(`${objectKey(key)}: ${expr}`);
  }
  // passthrough(): the X API validates the full body; allow forward-compatible
  // fields we didn't model so new spec features work without a regen.
  return `z.object({ ${lines.join(", ")} }).passthrough()`;
}

function mergeAllOf(parts: JsonSchema[], resolve: Resolver, depth: number): string {
  // Only object schemas merge cleanly; if every part is an object, combine
  // their properties. Otherwise fall back to a permissive object.
  const resolved = parts.map((p) => resolve(p));
  const allObjects = resolved.every(
    (p) => p.type === "object" || p.properties !== undefined,
  );
  if (!allObjects) return "z.any()";

  const merged: JsonSchema = { type: "object", properties: {}, required: [] };
  for (const p of resolved) {
    Object.assign(merged.properties, p.properties ?? {});
    if (Array.isArray(p.required)) merged.required.push(...p.required);
  }
  return objectZod(merged, resolve, depth);
}

/** A JS object key: bare identifier when safe, quoted string otherwise. */
function objectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : str(key);
}

/** Safely embed an arbitrary string as a TS double-quoted string literal. */
function str(value: string): string {
  return JSON.stringify(value);
}

function renderFile(spec: OpenApiSpec, tools: GeneratedTool[]): string {
  const header = [
    "// AUTO-GENERATED by scripts/gen-tools.ts — DO NOT EDIT BY HAND.",
    `// Source: ${OPENAPI_URL}`,
    `// OpenAPI ${spec.openapi ?? "?"} / X API ${spec.info?.version ?? "?"}`,
    `// Run \`npm run gen\` to regenerate.`,
    "",
    'import { z } from "zod";',
    "",
    'export type ParamLocation = "path" | "query";',
    "",
    "export interface ToolParam {",
    "  name: string;",
    "  in: ParamLocation;",
    "  schema: z.ZodTypeAny;",
    "}",
    "",
    "export interface ToolDef {",
    "  name: string;",
    "  description: string;",
    "  method: string;",
    "  path: string;",
    "  parameters: ToolParam[];",
    "  requestBody?: { schema: z.ZodTypeAny };",
    "}",
    "",
    "export const TOOLS: ToolDef[] = [",
  ];

  const body = tools.map((tool) => renderTool(tool));
  return [...header, body.join("\n"), "];", ""].join("\n");
}

function renderTool(tool: GeneratedTool): string {
  const lines: string[] = [];
  lines.push("  {");
  lines.push(`    name: ${str(tool.name)},`);
  lines.push(`    description: ${str(tool.description)},`);
  lines.push(`    method: ${str(tool.method)},`);
  lines.push(`    path: ${str(tool.path)},`);
  if (tool.params.length === 0) {
    lines.push("    parameters: [],");
  } else {
    lines.push("    parameters: [");
    for (const p of tool.params) {
      lines.push(`      { name: ${str(p.name)}, in: ${str(p.in)}, schema: ${p.expr} },`);
    }
    lines.push("    ],");
  }
  if (tool.bodyExpr) {
    lines.push(`    requestBody: { schema: ${tool.bodyExpr} },`);
  }
  lines.push("  },");
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
