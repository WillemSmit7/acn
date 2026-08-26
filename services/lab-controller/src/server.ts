import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ControllerConfig } from './config.js';
import { ActionBusyError, LabActionService } from './action-service.js';
import { isScenarioId, SCENARIOS } from './scenarios.js';

export function createControllerServer(
  config: ControllerConfig,
  service: LabActionService,
): Server {
  return createServer((request, response) => {
    void route(request, response, service).catch((error) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  }).listen(config.port, config.host);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  service: LabActionService,
): Promise<void> {
  const origin = request.headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    json(response, 403, { error: 'Origin is not allowed' });
    return;
  }
  cors(response, origin);

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/api/status') {
    json(response, 200, {
      ...service.status(),
      scenarios: Object.values(SCENARIOS).map(({ scriptPath: _scriptPath, ...scenario }) => scenario),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/actions/')) {
    const scenarioId = decodeURIComponent(url.pathname.slice('/api/actions/'.length));
    if (!isScenarioId(scenarioId)) {
      json(response, 404, { error: 'Unknown scenario' });
      return;
    }
    try {
      const action = await service.trigger(scenarioId);
      json(response, 202, { action });
    } catch (error) {
      if (error instanceof ActionBusyError) {
        json(response, 409, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  json(response, 404, { error: 'Not found' });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const port = Number.parseInt(url.port, 10);
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      port >= 4_200 && port <= 4_299;
  } catch {
    return false;
  }
}

function cors(response: ServerResponse, origin: string | undefined): void {
  if (origin !== undefined) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.writeHead(status).end(JSON.stringify(value));
}
