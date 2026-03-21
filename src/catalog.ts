import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { secureFetch, normalizePath } from "./client.js";

// ── Public types ──────────────────────────────────────────────────────

export interface Operation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
}

export interface SchemaDetail {
  type?: string;
  description?: string;
  required?: string[];
  properties?: SchemaProperty[];
  items?: SchemaDetail;
  pattern?: string;
  format?: string;
  enum?: string[];
  examples?: unknown[];
  readOnly?: boolean;
}

export interface SchemaProperty {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  pattern?: string;
  format?: string;
  enum?: string[];
  examples?: unknown[];
  items?: SchemaDetail;
  properties?: SchemaProperty[];
  readOnly?: boolean;
}

export interface Parameter {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema?: SchemaDetail;
}

export interface RequestBody {
  contentType?: string;
  schema?: SchemaDetail;
}

export interface ResponseSchema {
  statusCode: string;
  description?: string;
  schema?: SchemaDetail;
}

export interface OperationDetail {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: ResponseSchema[];
}

// ── Catalog ───────────────────────────────────────────────────────────

export class Catalog {
  private _source: string;
  private _operations: Operation[];
  private _byId: Map<string, Operation>;
  private _details: Map<string, OperationDetail>;

  constructor(
    source: string,
    operations: Operation[],
    byId: Map<string, Operation>,
    details: Map<string, OperationDetail>,
  ) {
    this._source = source;
    this._operations = operations;
    this._byId = byId;
    this._details = details;
  }

  source(): string {
    return this._source;
  }

  operations(): Operation[] {
    return [...this._operations];
  }

  get(id: string): Operation | undefined {
    return this._byId.get(id);
  }

  getDetail(id: string): OperationDetail | undefined {
    return this._details.get(id);
  }
}

// ── Loader ────────────────────────────────────────────────────────────

/**
 * Load the bundled OpenAPI YAML spec from the file shipped next to the
 * compiled JS output.
 */
function loadBundledSpec(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return readFileSync(join(__dirname, "openapi.yaml"), "utf-8");
}

/**
 * Load the OpenAPI catalog from a URL, falling back to the bundled YAML file.
 */
export async function loadCatalog(
  specUrl: string,
  apiKey?: string,
  fallbackSpec?: string,
): Promise<Catalog> {
  let yamlText: string | undefined;
  let source = specUrl;

  // Try fetching the spec from the URL.
  if (specUrl.trim()) {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["X-API-KEY"] = apiKey;
      }
      const resp = await secureFetch(specUrl, { headers });
      if (resp.ok) {
        yamlText = await resp.text();
      }
    } catch {
      // fetch failed, will fall through to fallback
    }
  }

  // Fall back to inline spec (used in tests).
  if (!yamlText && fallbackSpec) {
    yamlText = fallbackSpec;
    source = "bundled-fallback";
  }

  // Fall back to bundled spec file.
  if (!yamlText) {
    try {
      yamlText = loadBundledSpec();
      source = "bundled-spec";
    } catch {
      throw new Error(
        "Failed to fetch OpenAPI spec from server and no bundled spec found",
      );
    }
  }

  return parseOpenApiYaml(yamlText, source);
}

// ── Parser ────────────────────────────────────────────────────────────

function parseOpenApiYaml(yamlText: string, source: string): Catalog {
  const doc = YAML.parse(yamlText) as OpenApiDoc;

  if (!doc.paths || Object.keys(doc.paths).length === 0) {
    throw new Error("OpenAPI spec has no paths");
  }

  const resolver = new RefResolver(doc.components?.schemas ?? {});

  const operations: Operation[] = [];
  const details = new Map<string, OperationDetail>();

  for (const [route, pathItem] of Object.entries(doc.paths)) {
    for (const [method, op] of extractOperations(pathItem)) {
      if (!op || !op.operationId?.trim()) continue;

      const id = op.operationId.trim();
      const normalizedMethod = method.toUpperCase();
      const normalizedPath = normalizePath(route);

      const operation: Operation = {
        id,
        method: normalizedMethod,
        path: normalizedPath,
        summary: (op.summary ?? "").trim(),
        description: (op.description ?? "").trim(),
        tags: op.tags ?? [],
        deprecated: op.deprecated ?? false,
      };
      operations.push(operation);

      // Build detail.
      const detail: OperationDetail = {
        ...operation,
        parameters: [],
        responses: [],
      };

      // Resolve parameters.
      if (op.parameters) {
        for (const p of op.parameters) {
          const param: Parameter = {
            name: p.name,
            in: p.in,
            description: (p.description ?? "").trim(),
            required: p.required ?? false,
          };
          if (p.schema) {
            let schema = resolver.resolveAny(p.schema, 0);
            schema = unwrapQueryParam(schema, p.name);
            param.schema = schema ?? undefined;
          }
          detail.parameters!.push(param);
        }
      }

      // Resolve request body.
      if (op.requestBody?.content) {
        for (const [ct, media] of Object.entries(op.requestBody.content)) {
          if (media.schema) {
            detail.requestBody = {
              contentType: ct,
              schema: resolver.resolveAny(media.schema, 0) ?? undefined,
            };
            break; // take first content type
          }
        }
      }

      // Resolve responses.
      if (op.responses) {
        const responseCodes = Object.keys(op.responses).sort();
        for (const code of responseCodes) {
          const resp = op.responses[code];
          const rs: ResponseSchema = {
            statusCode: code,
            description: (resp.description ?? "").trim(),
          };
          if (resp.content) {
            for (const media of Object.values(resp.content)) {
              if (media.schema) {
                rs.schema = resolver.resolveAny(media.schema, 0) ?? undefined;
                break;
              }
            }
          }
          detail.responses!.push(rs);
        }
      }

      details.set(id, detail);
    }
  }

  // Sort operations by path, then method.
  operations.sort((a, b) => {
    if (a.path === b.path) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });

  const byId = new Map<string, Operation>();
  for (const op of operations) {
    byId.set(op.id, op);
  }

  if (operations.length === 0) {
    throw new Error("No operations found in OpenAPI spec");
  }

  return new Catalog(source, operations, byId, details);
}

// ── $ref resolver ─────────────────────────────────────────────────────

const MAX_RESOLVE_DEPTH = 15;

class RefResolver {
  private schemas: Record<string, unknown>;

  constructor(schemas: Record<string, unknown>) {
    this.schemas = schemas;
  }

  resolveAny(node: unknown, depth: number): SchemaDetail | null {
    if (!node || typeof node !== "object" || depth > MAX_RESOLVE_DEPTH) {
      return null;
    }

    const raw = node as RawSchema;

    if (raw.$ref) {
      return this.resolveRef(raw.$ref, depth + 1);
    }

    const sd: SchemaDetail = {
      type: raw.type,
      description: (raw.description ?? "").trim(),
      required: raw.required,
      pattern: raw.pattern,
      format: raw.format,
      enum: raw.enum,
      examples: raw.examples,
      readOnly: raw.readOnly,
    };

    // Resolve properties.
    if (raw.properties && typeof raw.properties === "object") {
      const requiredSet = new Set(raw.required ?? []);
      const propNames = Object.keys(raw.properties).sort();

      sd.properties = [];
      for (const name of propNames) {
        const propSchema = this.resolveAny(
          (raw.properties as Record<string, unknown>)[name],
          depth + 1,
        );
        const prop: SchemaProperty = { name };
        if (propSchema) {
          prop.type = propSchema.type;
          prop.description = propSchema.description;
          prop.pattern = propSchema.pattern;
          prop.format = propSchema.format;
          prop.enum = propSchema.enum;
          prop.examples = propSchema.examples;
          prop.items = propSchema.items;
          prop.properties = propSchema.properties;
          prop.readOnly = propSchema.readOnly;
        }
        if (requiredSet.has(name)) {
          prop.required = true;
        }
        sd.properties.push(prop);
      }
    }

    // Resolve items (for arrays).
    if (raw.items) {
      sd.items = this.resolveAny(raw.items, depth + 1) ?? undefined;
    }

    return sd;
  }

  private resolveRef(ref: string, depth: number): SchemaDetail | null {
    const prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) return null;
    const name = ref.slice(prefix.length);
    const node = this.schemas[name];
    if (!node) return null;
    return this.resolveAny(node, depth);
  }
}

// ── Query param unwrap ────────────────────────────────────────────────

/**
 * Handles the apidog pattern where query params are wrapped:
 *   schema: { type: object, properties: { paramName: { $ref: '...' } } }
 * When the wrapper has exactly one property matching the param name,
 * return the inner schema instead.
 */
function unwrapQueryParam(
  schema: SchemaDetail | null,
  paramName: string,
): SchemaDetail | null {
  if (!schema || schema.type !== "object" || !schema.properties) return schema;
  if (schema.properties.length !== 1) return schema;
  if (schema.properties[0].name !== paramName) return schema;

  const inner = schema.properties[0];
  return {
    type: inner.type,
    description: inner.description,
    pattern: inner.pattern,
    format: inner.format,
    enum: inner.enum,
    examples: inner.examples,
    items: inner.items,
    properties: inner.properties,
    readOnly: inner.readOnly,
  };
}

// ── Raw OpenAPI types (for YAML parsing) ──────────────────────────────

interface RawSchema {
  $ref?: string;
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  items?: unknown;
  pattern?: string;
  format?: string;
  enum?: string[];
  examples?: unknown[];
  readOnly?: boolean;
}

interface OpenApiDoc {
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, unknown>;
  };
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiParameter {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema?: unknown;
}

interface OpenApiMediaType {
  schema?: unknown;
}

interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

function extractOperations(
  pathItem: OpenApiPathItem,
): [string, OpenApiOperation | undefined][] {
  return [
    ["GET", pathItem.get],
    ["POST", pathItem.post],
    ["PUT", pathItem.put],
    ["PATCH", pathItem.patch],
    ["DELETE", pathItem.delete],
  ];
}
