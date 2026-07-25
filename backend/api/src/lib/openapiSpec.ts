/** Authored by: Mohit Singh */
//
// A minimal, hand-written OpenAPI 3.0 document for the public /api/v1 surface (Phase 7's "publish
// an OpenAPI spec for consumers"). Deliberately small — one endpoint, documented accurately —
// rather than auto-generated from the internal (much larger, session-authed) route set, since
// only /api/v1/businesses is actually public. Served unauthenticated at GET /api/v1/openapi.json
// so a prospective consumer can discover the contract before they have a key.
export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "business-scout-ai Public API",
    version: "1.0.0",
    description:
      "Read-only access to the deduplicated master businesses database. Authenticate with a " +
      "static API key (Authorization: Bearer <key>, or X-API-Key: <key>) — never the cookie-" +
      "based session the frontend uses.",
  },
  servers: [{ url: "/api/v1" }],
  security: [{ ApiKeyAuth: [] }],
  paths: {
    "/businesses": {
      get: {
        summary: "List businesses",
        parameters: [
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "city", in: "query", schema: { type: "string" } },
          {
            name: "enrichmentStatus",
            in: "query",
            schema: { type: "string", enum: ["queued", "crawling", "enriched", "failed"] },
          },
          { name: "hasEmail", in: "query", schema: { type: "boolean" } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "A page of matching businesses.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { type: "object" } },
                    pagination: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        limit: { type: "integer" },
                        offset: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Missing or invalid API key." },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description: "Also accepted as `Authorization: Bearer <key>`.",
      },
    },
  },
} as const;
