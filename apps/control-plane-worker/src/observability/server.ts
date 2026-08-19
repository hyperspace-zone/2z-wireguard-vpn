import { createServer, type Server } from "node:http";
import type { HealthRegistry, RuntimeMetrics } from "@hyperspace-zone/shared";

export interface WorkerObservabilityServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWorkerObservabilityServer(input: {
  host: string;
  port: number;
  health: HealthRegistry;
  metrics: RuntimeMetrics;
}): WorkerObservabilityServer {
  const server = createServer((request, response) => {
    if (request.url?.split("?")[0] === "/metrics") {
      const body = input.metrics.renderPrometheus();
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8"
      });
      response.end(body);
      return;
    }
    if (request.url?.split("?")[0] === "/health") {
      const snapshot = input.health.snapshot();
      response.writeHead(snapshot.ok ? 200 : 503, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(snapshot));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  return {
    start: () => listen(server, input.port, input.host),
    stop: () => close(server)
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
