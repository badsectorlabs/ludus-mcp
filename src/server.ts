import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Catalog } from "./catalog.js";
import { LudusClient } from "./client.js";

// ── Input schemas ─────────────────────────────────────────────────────

const ListOperationsInputSchema = z.object({
  tag: z
    .string()
    .optional()
    .describe("Optional tag filter (case-insensitive contains match)"),
  query: z
    .string()
    .optional()
    .describe(
      "Optional text filter applied to operation id, path, summary, and description",
    ),
  include_deprecated: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include deprecated operations in results"),
});

const DescribeOperationInputSchema = z.object({
  operation_id: z
    .string()
    .describe("Operation ID from list_ludus_operations"),
});

const CallApiInputSchema = z.object({
  operation_id: z
    .string()
    .describe("Operation ID from list_ludus_operations"),
  path_params: z
    .record(z.string())
    .optional()
    .describe("Path parameters for templated paths"),
  query_params: z
    .record(z.string())
    .optional()
    .describe("Query string parameters"),
  body: z
    .record(z.any())
    .optional()
    .describe("Request body for POST/PUT/PATCH operations"),
  content_type: z
    .string()
    .optional()
    .describe("Request content type; default application/json"),
});

// ── Output schemas ────────────────────────────────────────────────────

const OperationSummarySchema = z.object({
  operation_id: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  deprecated: z.boolean(),
});

const ListOperationsOutputSchema = z.object({
  source: z.string().describe("Where the OpenAPI spec was loaded from"),
  operation_count: z.number().describe("Number of matched operations"),
  operations: z.array(OperationSummarySchema),
});

const DescribeOperationOutputSchema = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  deprecated: z.boolean(),
  parameters: z.array(z.any()).optional(),
  requestBody: z.any().optional(),
  responses: z.array(z.any()).optional(),
});

// ── Server factory ────────────────────────────────────────────────────

export interface LudusMcpServer {
  server: McpServer;
  updateCatalog(newCatalog: Catalog): void;
}

export function createMcpServer(
  initialCatalog: Catalog,
  client: LudusClient,
): LudusMcpServer {
  let catalog = initialCatalog;

  const server = new McpServer(
    {
      name: "ludus-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "Ludus local MCP server. Discover operations with list_ludus_operations, inspect parameters with describe_ludus_operation, then execute with call_ludus_api.",
    },
  );

  // ── list_ludus_operations ──────────────────────────────────────────

  server.registerTool(
    "list_ludus_operations",
    {
      title: "List Ludus Operations",
      description:
        "List available Ludus API operations loaded from OpenAPI spec. Filter by tag or free-text query.",
      inputSchema: ListOperationsInputSchema,
      outputSchema: ListOperationsOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const tag = (args.tag ?? "").trim().toLowerCase();
      const query = (args.query ?? "").trim().toLowerCase();
      const includeDeprecated = args.include_deprecated ?? false;

      const matched = catalog.operations().filter((op) => {
        if (op.deprecated && !includeDeprecated) return false;
        if (tag && !operationHasTag(op, tag)) return false;
        if (query && !operationMatchesQuery(op, query)) return false;
        return true;
      });

      const structuredContent = {
        source: catalog.source(),
        operation_count: matched.length,
        operations: matched.map((op) => ({
          operation_id: op.id,
          method: op.method,
          path: op.path,
          summary: op.summary,
          tags: op.tags,
          deprecated: op.deprecated,
        })),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );

  // ── describe_ludus_operation ────────────────────────────────────────

  server.registerTool(
    "describe_ludus_operation",
    {
      title: "Describe Ludus Operation",
      description:
        "Get full parameter, request body, and response schemas for a single Ludus API operation.",
      inputSchema: DescribeOperationInputSchema,
      outputSchema: DescribeOperationOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const id = args.operation_id.trim();
      if (!id) {
        return {
          isError: true,
          content: [{ type: "text", text: "operation_id is required" }],
        };
      }

      const detail = catalog.getDetail(id);
      if (!detail) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown operation_id "${id}"; use list_ludus_operations to discover available operations`,
            },
          ],
        };
      }

      const json = JSON.stringify(detail, null, 2);
      return {
        content: [{ type: "text", text: json }],
        structuredContent: JSON.parse(json),
      };
    },
  );

  // ── call_ludus_api ─────────────────────────────────────────────────

  server.registerTool(
    "call_ludus_api",
    {
      title: "Call Ludus API",
      description:
        "Execute a Ludus API operation by operation_id from list_ludus_operations. " +
        "For multipart/form-data operations, set content_type to 'multipart/form-data' " +
        "and pass file fields as local file paths (not file contents) — the server reads the file from disk.",
      inputSchema: CallApiInputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const opId = args.operation_id.trim();
      const op = catalog.get(opId);
      if (!op) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown operation_id "${opId}"; use list_ludus_operations to discover available operations`,
            },
          ],
        };
      }

      try {
        const resp = await client.do({
          method: op.method,
          path: op.path,
          pathParams: args.path_params,
          queryParams: args.query_params,
          body: args.body,
          contentType: args.content_type,
        });

        const result: Record<string, unknown> = {
          operation_id: op.id,
          method: op.method,
          path: op.path,
          status_code: resp.statusCode,
          success: resp.success,
        };

        if (resp.json !== null) {
          result.response = resp.json;
        } else if (resp.body) {
          result.response = resp.body;
        }

        if (!resp.success) {
          result.error = `Ludus API returned status ${resp.statusCode}`;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !resp.success,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  operation_id: op.id,
                  method: op.method,
                  path: op.path,
                  error: message,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  return {
    server,
    updateCatalog(newCatalog: Catalog) {
      catalog = newCatalog;
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function operationHasTag(
  op: { tags: string[] },
  tag: string,
): boolean {
  return op.tags.some((t) => t.toLowerCase().includes(tag));
}

function operationMatchesQuery(
  op: { id: string; path: string; summary: string; description: string },
  query: string,
): boolean {
  const haystack = `${op.id} ${op.path} ${op.summary} ${op.description}`.toLowerCase();
  return haystack.includes(query);
}
