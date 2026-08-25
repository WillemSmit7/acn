import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePingLatencyMs, classifyPingExit, ping } from '../src/checks/ping.js';

test('parsePingLatencyMs takes the lowest reply time', () => {
  const output = [
    'PING 10.255.0.3 (10.255.0.3) 56(84) bytes of data.',
    '64 bytes from 10.255.0.3: icmp_seq=1 ttl=64 time=2.71 ms',
    '64 bytes from 10.255.0.3: icmp_seq=2 ttl=64 time=1.42 ms',
  ].join('\n');

  assert.equal(parsePingLatencyMs(output), 1.42);
});

test('parsePingLatencyMs handles the sub-millisecond form', () => {
  assert.equal(parsePingLatencyMs('64 bytes from 127.0.0.1: icmp_seq=1 time<1 ms'), 1);
});

test('parsePingLatencyMs returns null when nothing replied', () => {
  const output = [
    'PING 10.255.0.3 (10.255.0.3) 56(84) bytes of data.',
    '--- 10.255.0.3 ping statistics ---',
    '2 packets transmitted, 0 received, 100% packet loss',
  ].join('\n');

  assert.equal(parsePingLatencyMs(output), null);
});

test('classifyPingExit treats exit 0 as success', () => {
  assert.equal(classifyPingExit(0, ''), null);
});

test('classifyPingExit treats exit 1 as an unreachable device', () => {
  assert.deepEqual(classifyPingExit(1, ''), {
    reachable: false,
    latencyMs: null,
    error: 'no reply within timeout',
  });
});

test('classifyPingExit distinguishes a broken check from a down device', () => {
  const result = classifyPingExit(2, 'ping: bad-host: Name or service not known');
  assert.equal(result?.reachable, false);
  assert.match(result?.error ?? '', /^check failed:/);
});

test('ping reports loopback as reachable', async () => {
  const result = await ping('127.0.0.1', { count: 1, timeoutSeconds: 2 });
  assert.equal(result.reachable, true);
  assert.ok(result.latencyMs !== null && result.latencyMs >= 0);
});

test('ping reports an unroutable address as unreachable', async () => {
  // TEST-NET-1 (RFC 5737) - reserved for documentation, never routed.
  const result = await ping('192.0.2.1', { count: 1, timeoutSeconds: 1 });
  assert.equal(result.reachable, false);
  assert.equal(result.latencyMs, null);
});
