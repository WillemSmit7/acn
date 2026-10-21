import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { GuardedActionService } from '../src/action-service.js';
import { createNetworkControllerServer } from '../src/server.js';

test('approval endpoint accepts only an exact operator body', async () => {
  const calls: unknown[][] = [];
  const service = {
    get: async () => ({ tool: 'enable_interface' }),
    approve: async (...args: unknown[]) => { calls.push(args); return { status: 'succeeded' }; },
  } as unknown as GuardedActionService;
  const server = createNetworkControllerServer({ host: '127.0.0.1', port: 0 }, service);
  await listening(server);
  const port = (server.address() as AddressInfo).port;
  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/api/actions/ACT-001/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:4200' },
      body: JSON.stringify({ approver: 'operator', command: 'docker exec anything' }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 0);

    const approved = await fetch(`http://127.0.0.1:${port}/api/actions/ACT-001/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:4200' },
      body: JSON.stringify({ approver: 'operator@example.test' }),
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(calls, [['ACT-001', 'operator@example.test']]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('non-local browser origins and malformed JSON are rejected safely', async () => {
  const service = {} as GuardedActionService;
  const server = createNetworkControllerServer({ host: '127.0.0.1', port: 0 }, service);
  await listening(server);
  const port = (server.address() as AddressInfo).port;
  try {
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { origin: 'https://example.com' },
    });
    assert.equal(forbidden.status, 403);
    const malformed = await fetch(`http://127.0.0.1:${port}/api/actions/ACT-001/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4200' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'request body is invalid JSON' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function listening(server: import('node:http').Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}
