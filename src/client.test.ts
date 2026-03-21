import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LudusClient } from "./client.ts";

// ── Unit tests (no network) ───────────────────────────────────────────

describe("LudusClient", () => {
  it("should construct with baseUrl", () => {
    const client = new LudusClient("https://localhost:8080", "test-key");
    assert.equal(client.baseUrl, "https://localhost:8080");
  });

  it("should reject empty API key", async () => {
    const client = new LudusClient("https://localhost:8080", "  ");
    await assert.rejects(
      () => client.do({ method: "GET", path: "/range" }),
      { message: "Missing API key" },
    );
  });

  it("should reject missing path parameters", async () => {
    const client = new LudusClient("https://localhost:8080", "test-key");
    await assert.rejects(
      () =>
        client.do({
          method: "GET",
          path: "/range/{rangeId}/vm/{vmId}",
          pathParams: { rangeId: "abc" },
        }),
      /Missing required path parameters: vmId/,
    );
  });

  it("should reject unsupported content type", async () => {
    const client = new LudusClient("https://localhost:8080", "test-key");
    await assert.rejects(
      () =>
        client.do({
          method: "POST",
          path: "/range",
          body: { foo: "bar" },
          contentType: "application/xml",
        }),
      /Unsupported content type: application\/xml/,
    );
  });

  it("should reject non-string body for text/plain", async () => {
    const client = new LudusClient("https://localhost:8080", "test-key");
    await assert.rejects(
      () =>
        client.do({
          method: "POST",
          path: "/range",
          body: { foo: "bar" },
          contentType: "text/plain",
        }),
      /text\/plain body must be a string/,
    );
  });
});

// ── Integration tests (mock HTTP server) ──────────────────────────────

describe("LudusClient integration", () => {
  let server: Server;
  let baseUrl: string;
  // Collect requests the mock server received
  let lastRequest: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  };

  before(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastRequest = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers as Record<string, string | string[] | undefined>,
            body,
          };

          // Route-specific responses
          if (req.url === "/api/v2/error") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "internal error" }));
          } else if (req.url === "/api/v2/text-response") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("plain text response");
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: "ok", received: body || null }));
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}/api/v2`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should send GET with correct headers", async () => {
    const client = new LudusClient(baseUrl, "my-api-key");
    const resp = await client.do({ method: "GET", path: "/range" });

    assert.equal(resp.statusCode, 200);
    assert.equal(resp.success, true);
    assert.equal(lastRequest.method, "GET");
    assert.equal(lastRequest.url, "/api/v2/range");
    assert.equal(lastRequest.headers["x-api-key"], "my-api-key");
    assert.equal(lastRequest.headers["accept"], "application/json");
  });

  it("should substitute path parameters", async () => {
    const client = new LudusClient(baseUrl, "key");
    await client.do({
      method: "GET",
      path: "/range/{rangeId}/vm/{vmId}",
      pathParams: { rangeId: "abc", vmId: "123" },
    });

    assert.equal(lastRequest.url, "/api/v2/range/abc/vm/123");
  });

  it("should encode query parameters", async () => {
    const client = new LudusClient(baseUrl, "key");
    await client.do({
      method: "GET",
      path: "/range",
      queryParams: { status: "active", limit: "10" },
    });

    // URL should contain both query params
    assert.ok(lastRequest.url.includes("status=active"));
    assert.ok(lastRequest.url.includes("limit=10"));
  });

  it("should send JSON body on POST", async () => {
    const client = new LudusClient(baseUrl, "key");
    const resp = await client.do({
      method: "POST",
      path: "/range",
      body: { name: "test-range", count: 3 },
    });

    assert.equal(lastRequest.method, "POST");
    assert.equal(
      lastRequest.headers["content-type"],
      "application/json",
    );
    const sentBody = JSON.parse(lastRequest.body);
    assert.equal(sentBody.name, "test-range");
    assert.equal(sentBody.count, 3);
    assert.equal(resp.success, true);
  });

  it("should send text/plain body", async () => {
    const client = new LudusClient(baseUrl, "key");
    await client.do({
      method: "PUT",
      path: "/range",
      body: "raw config data",
      contentType: "text/plain",
    });

    assert.equal(lastRequest.headers["content-type"], "text/plain");
    assert.equal(lastRequest.body, "raw config data");
  });

  it("should parse JSON response", async () => {
    const client = new LudusClient(baseUrl, "key");
    const resp = await client.do({ method: "GET", path: "/range" });

    assert.deepEqual(resp.json, { result: "ok", received: null });
    assert.equal(typeof resp.body, "string");
  });

  it("should handle non-JSON response", async () => {
    const client = new LudusClient(baseUrl, "key");
    const resp = await client.do({
      method: "GET",
      path: "/text-response",
    });

    assert.equal(resp.json, null);
    assert.equal(resp.body, "plain text response");
  });

  it("should report failure for error status codes", async () => {
    const client = new LudusClient(baseUrl, "key");
    const resp = await client.do({ method: "GET", path: "/error" });

    assert.equal(resp.statusCode, 500);
    assert.equal(resp.success, false);
    assert.deepEqual(resp.json, { error: "internal error" });
  });

  it("should not send body for GET requests", async () => {
    const client = new LudusClient(baseUrl, "key");
    await client.do({ method: "GET", path: "/range" });

    assert.equal(lastRequest.body, "");
    assert.equal(lastRequest.headers["content-type"], undefined);
  });

  it("should URL-encode path parameters with special characters", async () => {
    const client = new LudusClient(baseUrl, "key");
    await client.do({
      method: "GET",
      path: "/range/{rangeId}",
      pathParams: { rangeId: "my range/test" },
    });

    assert.equal(lastRequest.url, "/api/v2/range/my%20range%2Ftest");
  });

  it("should send multipart/form-data with file upload", async () => {
    // Create a temp file to upload
    const tmpFile = join(tmpdir(), `ludus-test-${Date.now()}.yml`);
    await writeFile(tmpFile, "range_config: test\nvms: []");

    try {
      const client = new LudusClient(baseUrl, "key");
      const resp = await client.do({
        method: "PUT",
        path: "/range",
        body: { file: tmpFile, force: true },
        contentType: "multipart/form-data",
      });

      assert.equal(resp.statusCode, 200);
      assert.equal(lastRequest.method, "PUT");
      // Content-Type should be multipart with boundary (set by fetch)
      assert.ok(
        (lastRequest.headers["content-type"] as string).includes(
          "multipart/form-data",
        ),
      );
      // Body should contain file content and force field
      assert.ok(lastRequest.body.includes("range_config: test"));
      assert.ok(lastRequest.body.includes("true"));
    } finally {
      await unlink(tmpFile);
    }
  });
});
