import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApprovalRequiredError, GuardedActionService } from './action-service.js';
import type { NetworkControllerConfig } from './config.js';
import { InvalidActionTransitionError } from './firestore-repository.js';

export function createNetworkControllerServer(
  config: Pick<NetworkControllerConfig, 'host' | 'port'>,
  service: GuardedActionService,
): Server {
  return createServer((request, response) => {
    void route(request, response, service).catch(() => {
      json(response, 500, { error: 'network controller request failed safely' });
    });
  }).listen(config.port, config.host);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  service: GuardedActionService,
): Promise<void> {
  const origin = request.headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    json(response, 403, { error: 'origin is not allowed' });
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
      ready: true,
      adapters: [
        'restore_ospf_cost', 'restore_ospf_adjacency', 'enable_interface',
        'restart_routing_service', 'restore_resource_profile',
      ],
      approvalRequired: true,
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/actions') {
    json(response, 200, { actions: await service.list() });
    return;
  }

  const match = /^\/api\/actions\/([A-Za-z0-9:_-]{1,160})(?:\/(approve|reject))?$/.exec(url.pathname);
  if (match === null) {
    json(response, 404, { error: 'not found' });
    return;
  }
  const actionId = match[1]!;
  const operation = match[2];
  if (request.method === 'GET' && operation === undefined) {
    const action = await service.get(actionId);
    json(response, action === null ? 404 : 200, action === null ? { error: 'action not found' } : { action });
    return;
  }
  if (request.method !== 'POST' || operation === undefined) {
    json(response, 405, { error: 'method not allowed' });
    return;
  }

  try {
    const body = await readJson(request);
    if (operation === 'approve') {
      assertExactKeys(body, ['approver']);
      const candidate = await service.get(actionId);
      if (candidate === null) {
        json(response, 404, { error: 'action not found' });
        return;
      }
      const action = await service.approve(actionId, string(body['approver']));
      json(response, 200, { action });
      return;
    }
    assertExactKeys(body, ['approver', 'reason']);
    const action = await service.reject(actionId, string(body['approver']), string(body['reason']));
    json(response, 200, { action });
  } catch (error) {
    if (error instanceof ApprovalRequiredError || error instanceof InvalidActionTransitionError) {
      json(response, 409, { error: safeError(error) });
      return;
    }
    if (error instanceof SyntaxError) {
      json(response, 400, { error: 'request body is invalid JSON' });
      return;
    }
    if (error instanceof InputError ||
        (error instanceof Error && /approver|rejection reason/.test(error.message))) {
      json(response, 400, { error: safeError(error) });
      return;
    }
    throw error;
  }
}

class InputError extends Error {}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4_096) throw new InputError('request body is too large');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InputError('request body must be an object');
  }
  return parsed as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new InputError('request body fields are invalid');
  }
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function safeError(error: Error): string { return error.message.slice(0, 300); }
function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const port = Number.parseInt(url.port, 10);
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      port >= 4_200 && port <= 4_299;
  } catch { return false; }
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
