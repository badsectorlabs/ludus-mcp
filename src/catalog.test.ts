import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "./catalog.ts";

const BASIC_SPEC = `openapi: 3.1.0
paths:
  /range:
    get:
      operationId: listRange
      summary: List range
      tags: [Range Management]
      parameters:
        - name: rangeID
          in: query
          description: The range to query
          required: false
          schema:
            type: string
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  rangeID:
                    type: string
    delete:
      operationId: deleteRange
      summary: Delete range
`;

const SPEC_WITH_REF = `openapi: 3.1.0
paths:
  /user:
    get:
      operationId: listUser
      summary: Get user
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UserObj'
components:
  schemas:
    UserObj:
      type: object
      required: [name]
      properties:
        name:
          type: string
          description: User name
        isAdmin:
          type: boolean
`;

const SPEC_WITH_NESTED_REF = `openapi: 3.1.0
paths:
  /range:
    get:
      operationId: getRange
      summary: Get range
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RangeObj'
components:
  schemas:
    IDType:
      type: string
      pattern: '^[A-Z]+$'
    RangeObj:
      type: object
      properties:
        id:
          $ref: '#/components/schemas/IDType'
        name:
          type: string
`;

const SPEC_WITH_ARRAY_REF = `openapi: 3.1.0
paths:
  /users:
    get:
      operationId: listUsers
      summary: List users
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/UserObj'
components:
  schemas:
    UserObj:
      type: object
      properties:
        name:
          type: string
`;

const SPEC_WITH_MISSING_REF = `openapi: 3.1.0
paths:
  /thing:
    get:
      operationId: getThing
      summary: Get thing
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DoesNotExist'
components:
  schemas: {}
`;

const SPEC_WITH_QUERY_PARAM_UNWRAP = `openapi: 3.1.0
paths:
  /range:
    get:
      operationId: listRange
      summary: List range
      parameters:
        - name: rangeID
          in: query
          description: The range to query
          required: false
          schema:
            type: object
            properties:
              rangeID:
                $ref: '#/components/schemas/rangeID'
      responses:
        '200':
          description: OK
components:
  schemas:
    rangeID:
      type: string
      pattern: '^[A-Z]+$'
      description: Range identifier
`;

const SPEC_WITH_REQUEST_BODY = `openapi: 3.1.0
paths:
  /range/deploy:
    post:
      operationId: deployRange
      summary: Deploy range
      parameters:
        - name: rangeID
          in: query
          description: Range to deploy
          required: false
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                tags:
                  type: string
                  description: ansible tags
                force:
                  type: boolean
                  description: force deploy
      responses:
        '201':
          description: range deployed
        '400':
          description: bad input
`;

describe("catalog", () => {
  describe("parseOperationsFromSpec", () => {
    it("should parse basic operations", async () => {
      const catalog = await loadCatalog("", undefined, BASIC_SPEC);
      const ops = catalog.operations();
      assert.equal(ops.length, 2);

      const listOp = catalog.get("listRange");
      assert.ok(listOp);
      assert.equal(listOp.method, "GET");
      assert.equal(listOp.path, "/range");

      const deleteOp = catalog.get("deleteRange");
      assert.ok(deleteOp);
      assert.equal(deleteOp.method, "DELETE");
    });

    it("should parse operation details with parameters", async () => {
      const catalog = await loadCatalog("", undefined, BASIC_SPEC);
      const detail = catalog.getDetail("listRange");
      assert.ok(detail);
      assert.equal(detail.parameters!.length, 1);
      assert.equal(detail.parameters![0].name, "rangeID");
      assert.equal(detail.responses!.length, 1);
      assert.equal(detail.responses![0].statusCode, "200");
    });
  });

  describe("$ref resolution", () => {
    it("should resolve simple $ref", async () => {
      const catalog = await loadCatalog("", undefined, SPEC_WITH_REF);
      const detail = catalog.getDetail("listUser");
      assert.ok(detail);
      assert.equal(detail.responses!.length, 1);

      const schema = detail.responses![0].schema;
      assert.ok(schema);
      assert.equal(schema.type, "object");
      assert.equal(schema.properties!.length, 2);

      // Properties are sorted alphabetically.
      const nameProp = schema.properties!.find((p) => p.name === "name");
      assert.ok(nameProp);
      assert.equal(nameProp.required, true);
    });

    it("should resolve nested $ref", async () => {
      const catalog = await loadCatalog("", undefined, SPEC_WITH_NESTED_REF);
      const detail = catalog.getDetail("getRange");
      assert.ok(detail);

      const schema = detail.responses![0].schema;
      assert.ok(schema);

      const idProp = schema.properties!.find((p) => p.name === "id");
      assert.ok(idProp);
      assert.equal(idProp.type, "string");
      assert.equal(idProp.pattern, "^[A-Z]+$");
    });

    it("should resolve $ref in array items", async () => {
      const catalog = await loadCatalog("", undefined, SPEC_WITH_ARRAY_REF);
      const detail = catalog.getDetail("listUsers");
      assert.ok(detail);

      const schema = detail.responses![0].schema;
      assert.ok(schema);
      assert.equal(schema.type, "array");
      assert.ok(schema.items);
      assert.equal(schema.items.type, "object");
      assert.equal(schema.items.properties!.length, 1);
    });

    it("should handle missing $ref target gracefully", async () => {
      const catalog = await loadCatalog("", undefined, SPEC_WITH_MISSING_REF);
      const detail = catalog.getDetail("getThing");
      assert.ok(detail);

      // Missing ref should produce null/undefined schema.
      const schema = detail.responses![0].schema;
      assert.equal(schema, undefined);
    });
  });

  describe("query param unwrap", () => {
    it("should unwrap apidog-style query params", async () => {
      const catalog = await loadCatalog("", undefined, SPEC_WITH_QUERY_PARAM_UNWRAP);
      const detail = catalog.getDetail("listRange");
      assert.ok(detail);
      assert.equal(detail.parameters!.length, 1);

      const schema = detail.parameters![0].schema;
      assert.ok(schema);
      assert.equal(schema.type, "string");
      assert.equal(schema.pattern, "^[A-Z]+$");
    });
  });

  describe("request body and responses", () => {
    it("should parse operation with request body", async () => {
      const catalog = await loadCatalog("", undefined, SPEC_WITH_REQUEST_BODY);
      const detail = catalog.getDetail("deployRange");
      assert.ok(detail);

      assert.equal(detail.parameters!.length, 1);
      assert.equal(detail.parameters![0].name, "rangeID");

      assert.ok(detail.requestBody);
      assert.equal(detail.requestBody.contentType, "application/json");
      assert.equal(detail.requestBody.schema!.properties!.length, 2);

      assert.equal(detail.responses!.length, 2);
    });
  });

  describe("bundled spec fallback", () => {
    it("should load bundled spec when no URL is provided", async () => {
      const catalog = await loadCatalog("");
      assert.equal(catalog.source(), "bundled-spec");

      const ops = catalog.operations();
      assert.ok(ops.length > 0);
    });
  });
});
