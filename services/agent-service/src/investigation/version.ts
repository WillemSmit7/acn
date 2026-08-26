import { createHash } from 'node:crypto';
import type { DeterministicRootCause, InvestigableIncident } from '../models/types.js';

/** Stable version of the diagnosis, independent of later recovery events. */
export function diagnosisVersion(rootCause: DeterministicRootCause): string {
  const canonical = JSON.stringify({
    type: rootCause.type,
    devices: rootCause.devices,
    summary: rootCause.summary,
    confidence: rootCause.confidence,
    evidence: rootCause.evidence,
    predictedUnreachable: rootCause.predictedUnreachable,
    observedUnreachable: rootCause.observedUnreachable,
    predictionMatches: rootCause.predictionMatches,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function runIdFor(incident: InvestigableIncident, version: string): string {
  return `RUN-${incident.incidentId}-${version.slice(0, 12).toUpperCase()}`;
}
