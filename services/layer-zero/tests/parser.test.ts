import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrrLine } from '../src/normalize/parser.js';

/**
 * Every line in this file was copied verbatim out of the running lab
 * (FRR 10.2.1). Parsers written against imagined log formats pass their tests
 * and fail in production, so the fixtures are real.
 */

test('parses a zebra interface message', () => {
  const parsed = parseFrrLine(
    '2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)',
  );

  assert.notEqual(parsed, null);
  assert.equal(parsed?.daemon, 'ZEBRA');
  assert.equal(parsed?.code, 'SBFM4-2P25V');
  assert.equal(parsed?.errorCode, null);
  assert.equal(parsed?.message, 'MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)');
});

test('parses an ospf adjacency-change message', () => {
  const parsed = parseFrrLine(
    '2026/08/25 19:13:33 OSPF: [Y05P2-YJVXY] AdjChg: Nbr 10.255.0.3, NbrIP 10.0.23.2 ' +
      '(default) on eth2:10.0.23.1: Full -> Deleted (KillNbr)',
  );

  assert.equal(parsed?.daemon, 'OSPF');
  assert.match(parsed?.message ?? '', /^AdjChg: /);
});

test('the FRR timestamp is read as UTC, not as host-local time', () => {
  const parsed = parseFrrLine(
    '2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)',
  );

  // The lab containers run UTC. Reading this as local time would shift every
  // event by the collector host's offset (+02:00 here), silently corrupting
  // the ordering Increment 3 correlates on.
  assert.equal(parsed?.loggedAt.toISOString(), '2026-08-25T19:14:43.000Z');
});

test('extracts the [EC nnn] error code when present', () => {
  const parsed = parseFrrLine(
    '2026/08/25 18:45:41 ZEBRA: [NNACN-54BDA][EC 4043309110] Disabling MPLS support (no kernel support)',
  );

  assert.equal(parsed?.errorCode, 4043309110);
  assert.equal(parsed?.message, 'Disabling MPLS support (no kernel support)');
});

test('returns null for FRR startup noise that is not in the structured format', () => {
  // Both of these are emitted by the real container during boot.
  assert.equal(parseFrrLine('[33|zebra] sending configuration'), null);
  assert.equal(parseFrrLine('Waiting for children to finish applying config...'), null);
});

test('returns null rather than throwing on empty or malformed input', () => {
  assert.equal(parseFrrLine(''), null);
  assert.equal(parseFrrLine('   '), null);
  assert.equal(parseFrrLine('not a log line at all'), null);
  assert.equal(parseFrrLine('2026/08/25 ZEBRA: broken'), null);
});

test('tolerates surrounding whitespace', () => {
  const parsed = parseFrrLine(
    '  2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_UP eth2 vrf default(0)  ',
  );
  assert.equal(parsed?.daemon, 'ZEBRA');
});
