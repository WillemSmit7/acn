#!/usr/bin/env node
/**
 * Credit-free focused E2E: raw probe log -> Layer 0 event -> deterministic
 * incident diagnosis -> agent prompt and conclusion agreement.
 */
import assert from 'node:assert/strict';
import { parseFrrLine } from '../services/layer-zero/dist/normalize/parser.js';
import { normalize } from '../services/layer-zero/dist/normalize/rules.js';
import { inferRootCause } from '../services/incident-service/dist/correlation/rootCause.js';
import { buildPrompt } from '../services/agent-service/dist/investigation/prompt.js';
import { agrees } from '../services/agent-service/dist/service.js';

const cases = [
  ['configuration_drift', 'configuration_drift', 'component=ospf interface=eth2 expected=10 observed=65535'],
  ['routing_session_down', 'routing_session_failure', 'protocol=ospf interface=eth2 interfaceState=up'],
  ['interface_admin_down', 'interface_misconfiguration', 'interface=eth2 adminState=down'],
  ['routing_service_down', 'routing_service_failure', 'service=ospfd processState=stopped'],
  ['resource_exhaustion', 'resource_exhaustion', 'resource=cpu impactedService=ospfd'],
];

for (const [eventType, rootCauseType, attributes] of cases) {
  const raw = `2026/08/26 20:00:00 ACNMON: [ACNMO-00001] EVENT type=${eventType} ${attributes}`;
  const parsed = parseFrrLine(raw);
  assert.ok(parsed, `${eventType}: raw observation parses`);
  const normalized = normalize('r2', parsed);
  assert.ok(normalized, `${eventType}: observation normalizes`);
  assert.equal(normalized.eventType, eventType);

  const observed = {
    ...normalized,
    id: `evt-${eventType}`,
    sourceLogId: `log-${eventType}`,
  };
  const rootCause = inferRootCause([observed], []);
  assert.equal(rootCause.type, rootCauseType, `${eventType}: correct deterministic diagnosis`);

  const incident = {
    incidentId: `INC-${eventType}`,
    status: 'open',
    severity: normalized.severity === 'critical' ? 'critical' : 'warning',
    symptoms: [rootCause.summary],
    affectedDevices: ['r2'],
    eventIds: [observed.id],
    rootCause,
  };
  const evidence = {
    events: [{
      ...observed,
      occurredAt: observed.occurredAt.toISOString(),
    }],
    logs: [{
      id: observed.sourceLogId,
      deviceId: 'r2',
      raw,
      daemon: parsed.daemon,
      loggedAt: parsed.loggedAt.toISOString(),
    }],
  };
  const prompt = buildPrompt(incident, evidence);
  assert.match(prompt.input, new RegExp(observed.id));
  assert.match(prompt.input, new RegExp(observed.sourceLogId));
  assert.equal(agrees(incident, {
    rootCauseType,
    rootCauseDevices: rootCause.devices,
    summary: rootCause.summary,
    confidence: 'high',
    reasoning: ['Deterministic fixture conclusion'],
    citedEventIds: [observed.id],
    citedLogIds: [observed.sourceLogId],
  }), true, `${eventType}: agent conclusion agrees`);

  console.log(`PASS ${eventType} -> ${rootCauseType}`);
}

console.log(`PASS focused E2E verified ${cases.length} ISP failure categories without an API call`);
