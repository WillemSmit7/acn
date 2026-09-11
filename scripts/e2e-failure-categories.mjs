#!/usr/bin/env node
/**
 * Credit-free focused E2E: autonomous state snapshot -> transition event ->
 * neutral GPT evidence -> blind conclusion -> hidden ground-truth evaluation.
 */
import assert from 'node:assert/strict';
import { AutonomousStateObserver } from '../services/layer-zero/dist/observer/stateObserver.js';
import { inferRootCause } from '../services/incident-service/dist/correlation/rootCause.js';
import { buildPrompt } from '../services/agent-service/dist/investigation/prompt.js';
import { evaluate } from '../services/agent-service/dist/service.js';

const cases = [
  {
    eventType: 'configuration_drift', rootCauseType: 'configuration_drift', deviceId: 'r2',
    facts: { ospfCost: 65535, passiveEth2: false, eth2AdminDown: false },
    raw: 'interface eth2\n ip ospf cost 65535', observedUnreachable: [],
  },
  {
    eventType: 'routing_session_down', rootCauseType: 'routing_session_failure', deviceId: 'r2',
    facts: { ospfCost: 10, passiveEth2: true, eth2AdminDown: false },
    raw: 'router ospf\n passive-interface eth2', observedUnreachable: ['r3', 'pc2'],
  },
  {
    eventType: 'interface_admin_down', rootCauseType: 'interface_misconfiguration', deviceId: 'r2',
    facts: { ospfCost: 10, passiveEth2: false, eth2AdminDown: true },
    raw: 'interface eth2\n shutdown', observedUnreachable: ['r3', 'pc2'],
  },
  {
    eventType: 'routing_service_down', rootCauseType: 'routing_service_failure', deviceId: 'r3',
    facts: { ospfdProcessState: 'missing', cpuQuotaPercent: 100 },
    raw: 'ospfd=missing\ncpu.max=max 100000', observedUnreachable: ['r3', 'pc2'],
  },
  {
    eventType: 'resource_exhaustion', rootCauseType: 'resource_exhaustion', deviceId: 'r3',
    facts: { ospfdProcessState: 'stopped', cpuQuotaPercent: 10 },
    raw: 'ospfd=stopped\ncpu.max=10000 100000', observedUnreachable: ['r3', 'pc2'],
  },
];

for (const [index, scenario] of cases.entries()) {
  const observations = [];
  const snapshot = {
    deviceId: scenario.deviceId,
    observedAt: new Date('2026-08-26T20:00:00.000Z'),
    raw: scenario.raw,
    facts: scenario.facts,
  };
  const probe = { inspect: async () => [snapshot] };
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, line() {} };
  const observer = new AutonomousStateObserver(
    probe,
    60_000,
    (observation) => observations.push(observation),
    silentLogger,
  );
  await observer.poll();

  const observation = observations.find((item) => item.eventType === scenario.eventType);
  assert.ok(observation, `${scenario.eventType}: autonomous observer emits transition`);
  const observed = {
    ...observation,
    id: `evt-observation-${index + 1}`,
    source: 'layer-zero',
    sourceLogId: `log-observation-${index + 1}`,
    occurredAt: observation.observedAt,
  };
  const rootCause = inferRootCause([observed], scenario.observedUnreachable);
  assert.equal(rootCause.type, scenario.rootCauseType, `${scenario.eventType}: correct diagnosis`);
  assert.equal(rootCause.predictionMatches, true, `${scenario.eventType}: impact prediction matches`);

  const incident = {
    incidentId: `INC-BLIND-${String(index + 1).padStart(3, '0')}`,
    status: 'open',
    severity: observation.severity === 'critical' ? 'critical' : 'warning',
    startedAt: '2026-08-26T19:59:59.000Z',
    symptoms: [rootCause.summary],
    affectedDevices: [scenario.deviceId],
    eventIds: [observed.id],
    rootCause,
  };
  const evidence = {
    events: [{ ...observed, occurredAt: observed.occurredAt.toISOString() }],
    logs: [{
      id: observed.sourceLogId,
      deviceId: scenario.deviceId,
      raw: scenario.raw,
      daemon: 'ACNOBS',
      loggedAt: observed.occurredAt.toISOString(),
    }],
  };
  const prompt = buildPrompt(incident, evidence);
  assert.match(prompt.input, new RegExp(observed.id));
  assert.match(prompt.input, new RegExp(observed.sourceLogId));
  assert.doesNotMatch(prompt.input, new RegExp(scenario.eventType));
  assert.doesNotMatch(prompt.input, new RegExp(scenario.rootCauseType));
  const score = evaluate({
    rootCauseType: scenario.rootCauseType,
    rootCauseDevices: rootCause.devices,
    expectedRemediationTool: ({
      configuration_drift: 'restore_ospf_cost',
      routing_session_failure: 'restore_ospf_adjacency',
      interface_misconfiguration: 'enable_interface',
      routing_service_failure: 'restart_routing_service',
      resource_exhaustion: 'restore_resource_profile',
    })[scenario.rootCauseType],
  }, {
    rootCauseType: scenario.rootCauseType,
    rootCauseDevices: rootCause.devices,
    summary: rootCause.summary,
    confidence: 'high',
    reasoning: ['Autonomous observer fixture conclusion'],
    citedEventIds: [observed.id],
    citedLogIds: [observed.sourceLogId],
    remediationProposal: {
      tool: ({
        configuration_drift: 'restore_ospf_cost',
        routing_session_failure: 'restore_ospf_adjacency',
        interface_misconfiguration: 'enable_interface',
        routing_service_failure: 'restart_routing_service',
        resource_exhaustion: 'restore_resource_profile',
      })[scenario.rootCauseType],
      rationale: 'Fixture repair selected from neutral evidence.',
      citedEvidenceIds: [observed.id, observed.sourceLogId],
    },
  });
  assert.equal(score.overallMatch, true, `${scenario.eventType}: blind conclusion matches truth`);

  console.log(`PASS ${scenario.eventType} -> ${scenario.rootCauseType}`);
}

console.log(`PASS focused E2E verified ${cases.length} autonomous failure categories without an API call`);
