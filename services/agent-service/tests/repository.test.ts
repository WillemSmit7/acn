import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { toInvestigableIncident } from '../src/firebase/repository.js';

const readyDocument = {
  incidentId: 'INC-009',
  status: 'open',
  severity: 'warning',
  startedAt: Timestamp.fromDate(new Date('2026-09-14T14:55:08.000Z')),
  symptoms: ['r2 eth2 administratively down'],
  affectedDevices: ['r2'],
  eventIds: ['evt-interface', 'evt-admin'],
  investigationReady: true,
  settledAt: Timestamp.fromDate(new Date('2026-09-14T14:55:23.000Z')),
  investigationRevision: 1,
};

test('only explicitly ready, settled incident generations are investigable', () => {
  const incident = toInvestigableIncident('INC-009', readyDocument);
  assert.equal(incident?.investigationReady, true);
  assert.equal(incident?.investigationRevision, 1);
  assert.equal(incident?.settledAt, '2026-09-14T14:55:23.000Z');

  assert.equal(toInvestigableIncident('INC-009', {
    ...readyDocument, investigationReady: false,
  }), null);
  assert.equal(toInvestigableIncident('INC-009', {
    ...readyDocument, settledAt: null,
  }), null);
  assert.equal(toInvestigableIncident('INC-009', {
    ...readyDocument, investigationRevision: 0,
  }), null);
});

test('legacy incident documents without readiness metadata fail closed', () => {
  const {
    investigationReady: _ready,
    settledAt: _settledAt,
    investigationRevision: _revision,
    ...legacy
  } = readyDocument;
  assert.equal(toInvestigableIncident('INC-009', legacy), null);
});
