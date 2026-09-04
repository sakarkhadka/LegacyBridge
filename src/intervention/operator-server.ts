import { createServer, type Server, type ServerResponse } from "node:http";
import type { InterventionManager } from "./intervention-manager.js";

export type OperatorServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export async function createOperatorServer(manager: InterventionManager, options: { port?: number } = {}): Promise<OperatorServer> {
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "/status") {
      sendJson(response, 200, {
        status: manager.controlState.currentState(),
        owner: manager.controlState.currentOwner(),
        evidence: manager.evidence()
      });
      return;
    }

    sendJson(response, 404, {
      error: "not found"
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected operator server to listen on a TCP address");
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

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}
