import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CapabilityArtifact } from "../artifact/types.js";
import type { RuntimeAuthProvider } from "../auth/types.js";
import { invokeProductionCapability, isProductionInvokable } from "./production-catalog.js";
import { publicManifestFor } from "./manifest.js";

export type CapabilityCatalogServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export async function createCapabilityCatalogServer(options: {
  capabilities: CapabilityArtifact[];
  replayOrigin: string;
  authProvider?: RuntimeAuthProvider;
  port?: number;
}): Promise<CapabilityCatalogServer> {
  const capabilitiesById = new Map(options.capabilities.map((capability) => [capability.capability.id, capability]));
  const server = createServer(async (request, response) => {
    try {
      await routeCatalogRequest(request, response, capabilitiesById, options.replayOrigin, options.authProvider);
    } catch (error) {
      sendJson(response, 500, {
        error: "CATALOG_ERROR",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected capability catalog to listen on a TCP address");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function routeCatalogRequest(
  request: IncomingMessage,
  response: ServerResponse,
  capabilitiesById: Map<string, CapabilityArtifact>,
  replayOrigin: string,
  authProvider: RuntimeAuthProvider | undefined
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/capabilities") {
    sendJson(response, 200, [...capabilitiesById.values()].map(publicManifestFor));
    return;
  }

  const invokeMatch = url.pathname.match(/^\/capabilities\/([^/]+)\/invoke$/);
  if (request.method === "POST" && invokeMatch) {
    const capabilityId = decodeURIComponent(invokeMatch[1] ?? "");
    const capability = capabilitiesById.get(capabilityId);
    if (!capability) {
      sendJson(response, 404, {
        error: "CAPABILITY_NOT_FOUND"
      });
      return;
    }
    if (!isProductionInvokable(capability)) {
      sendJson(response, 403, {
        error: "CAPABILITY_NOT_APPROVED",
        status: capability.capability.status
      });
      return;
    }

    const body = await readJsonBody(request);
    const result = await invokeProductionCapability({
      capability,
      inputs: body,
      origin: replayOrigin,
      authProvider
    });
    sendJson(response, result.result.status === "failure" ? 422 : 200, result);
    return;
  }

  sendJson(response, 404, {
    error: "NOT_FOUND"
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}
