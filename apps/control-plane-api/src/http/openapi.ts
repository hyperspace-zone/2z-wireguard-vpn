import type { FastifyInstance, RouteOptions } from "fastify";

type JsonSchema = Record<string, unknown>;

interface OpenApiOperation {
  operationId?: string;
  requestBody?: JsonSchema;
  responses: Record<string, JsonSchema>;
}

interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export function registerOpenApiRoute(app: FastifyInstance): void {
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "DoubleZero WireGuard VPN Control Plane API",
      version: "0.1.0"
    },
    paths: {}
  };

  app.addHook("onRoute", (routeOptions: RouteOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      const verb = String(method).toLowerCase();
      if (verb === "head") {
        continue;
      }
      const path = openApiPath(routeOptions.url);
      document.paths[path] ??= {};
      document.paths[path][verb] = operationFromRoute(routeOptions);
    }
  });

  app.get("/openapi.json", async () => document);
}

function operationFromRoute(routeOptions: RouteOptions): OpenApiOperation {
  const schema = routeOptions.schema as {
    body?: JsonSchema;
    response?: Record<string | number, JsonSchema>;
  } | undefined;
  return {
    operationId: operationId(routeOptions.method, routeOptions.url),
    ...(schema?.body ? { requestBody: jsonRequestBody(schema.body) } : {}),
    responses: responseSchemas(schema?.response)
  };
}

function jsonRequestBody(schema: JsonSchema): JsonSchema {
  return {
    required: true,
    content: {
      "application/json": {
        schema
      }
    }
  };
}

function responseSchemas(response: Record<string | number, JsonSchema> | undefined): Record<string, JsonSchema> {
  if (!response) {
    return {
      "200": {
        description: "OK"
      }
    };
  }
  return Object.fromEntries(
    Object.entries(response).map(([statusCode, schema]) => [
      statusCode,
      {
        description: statusCode === "204" ? "No Content" : "Response",
        ...(statusCode === "204" ? {} : {
          content: {
            "application/json": {
              schema
            }
          }
        })
      }
    ])
  );
}

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(method: RouteOptions["method"], path: string): string {
  const verb = Array.isArray(method) ? String(method[0]) : String(method);
  return `${verb.toLowerCase()}_${openApiPath(path).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}
