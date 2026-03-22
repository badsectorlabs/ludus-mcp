import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMcpServer } from "./server.ts";
import { loadCatalog, type Catalog } from "./catalog.ts";
import { LudusClient } from "./client.ts";

// ── Fixtures ───────────────────────────────────────────────────────────

const SPEC = `
openapi: "3.1.0"
info:
  title: Test API
  version: "1.0"
paths:
  /range:
    get:
      operationId: getRange
      summary: Get all ranges
      description: Returns a list of ranges
      tags:
        - Range Management
      responses:
        "200":
          description: success
  /range/{rangeId}:
    get:
      operationId: getRangeById
      summary: Get a range by ID
      description: Returns a single range
      tags:
        - Range Management
      parameters:
        - name: rangeId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: success
    delete:
      operationId: deleteRange
      summary: Delete a range
      description: Destroys a range and all VMs
      tags:
        - Range Management
      parameters:
        - name: rangeId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: deleted
  /templates:
    get:
      operationId: getTemplates
      summary: List templates
      description: Returns available VM templates
      tags:
        - Template Management
      responses:
        "200":
          description: success
  /deprecated-endpoint:
    get:
      operationId: deprecatedOp
      summary: Old endpoint
      description: This is deprecated
      tags:
        - Legacy
      deprecated: true
      responses:
        "200":
          description: success
`;

// Helper to call a tool handler through the McpServer's internal tool map.
// Since McpServer doesn't expose a direct "call tool" method for unit tests,
// we test the logic by constructing a Catalog and exercising the handler
// functions indirectly via the MCP protocol's callTool.
// We use the server's connect + client pattern for a proper integration test.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function setupTestServer(catalog: Catalog, client: LudusClient) {
  const { server } = createMcpServer(catalog, client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  return { mcpClient, server };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("MCP Server", () => {
  describe("list_ludus_operations", () => {
    it("should list all operations", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "list_ludus_operations",
        arguments: {},
      });

      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(parsed.operation_count, 4); // excludes deprecated by default
      assert.ok(
        parsed.operations.some(
          (op: { operation_id: string }) => op.operation_id === "getRange",
        ),
      );
      assert.ok(
        !parsed.operations.some(
          (op: { operation_id: string }) => op.operation_id === "deprecatedOp",
        ),
      );
    });

    it("should include deprecated when requested", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "list_ludus_operations",
        arguments: { include_deprecated: true },
      });

      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(parsed.operation_count, 5);
      assert.ok(
        parsed.operations.some(
          (op: { operation_id: string }) => op.operation_id === "deprecatedOp",
        ),
      );
    });

    it("should filter by tag", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "list_ludus_operations",
        arguments: { tag: "template" },
      });

      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(parsed.operation_count, 1);
      assert.equal(parsed.operations[0].operation_id, "getTemplates");
    });

    it("should filter by query", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "list_ludus_operations",
        arguments: { query: "delete" },
      });

      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(parsed.operation_count, 1);
      assert.equal(parsed.operations[0].operation_id, "deleteRange");
    });

    it("should return source info", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "list_ludus_operations",
        arguments: {},
      });

      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(parsed.source, "bundled-fallback");
    });
  });

  describe("describe_ludus_operation", () => {
    it("should return operation detail", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "describe_ludus_operation",
        arguments: { operation_id: "getRangeById" },
      });

      assert.equal(result.isError, undefined);
      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(parsed.id, "getRangeById");
      assert.equal(parsed.method, "GET");
      assert.equal(parsed.path, "/range/{rangeId}");
      assert.ok(parsed.parameters);
      assert.equal(parsed.parameters[0].name, "rangeId");
    });

    it("should return error for unknown operation", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "describe_ludus_operation",
        arguments: { operation_id: "nonexistent" },
      });

      assert.equal(result.isError, true);
      const text = (
        result.content as Array<{ type: string; text: string }>
      )[0].text;
      assert.ok(text.includes("Unknown operation_id"));
      assert.ok(text.includes("list_ludus_operations"));
    });

    it("should return error for empty operation_id", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "describe_ludus_operation",
        arguments: { operation_id: "  " },
      });

      assert.equal(result.isError, true);
    });
  });

  describe("call_ludus_api", () => {
    it("should return error for unknown operation", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const result = await mcpClient.callTool({
        name: "call_ludus_api",
        arguments: { operation_id: "nonexistent" },
      });

      assert.equal(result.isError, true);
      const text = (
        result.content as Array<{ type: string; text: string }>
      )[0].text;
      assert.ok(text.includes("Unknown operation_id"));
      assert.ok(text.includes("list_ludus_operations"));
    });
  });

  describe("tool listing", () => {
    it("should register all three tools", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const tools = await mcpClient.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "call_ludus_api",
        "describe_ludus_operation",
        "list_ludus_operations",
      ]);
    });

    it("should have correct annotations on tools", async () => {
      const catalog = await loadCatalog("", undefined, SPEC);
      const client = new LudusClient("https://localhost:8080", "test-key");
      const { mcpClient } = await setupTestServer(catalog, client);

      const tools = await mcpClient.listTools();
      const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));

      // list and describe are read-only
      assert.equal(byName["list_ludus_operations"].annotations?.readOnlyHint, true);
      assert.equal(byName["describe_ludus_operation"].annotations?.readOnlyHint, true);
      // call is not read-only
      assert.equal(byName["call_ludus_api"].annotations?.readOnlyHint, false);
    });
  });
});
