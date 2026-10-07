import { createHash } from 'node:crypto';
import type { InvestigableIncident } from '../models/types.js';

/** One blind investigation per settled evidence generation and prompt contract. */
export function diagnosisVersion(
  incidentId: string,
  investigationRevision: number,
  promptVersion: string,
): string {
  const canonical = JSON.stringify({ incidentId, investigationRevision, promptVersion });
  return createHash('sha256').update(canonical).digest('hex');
}

export function runIdFor(incident: InvestigableIncident, version: string): string {
  return `RUN-${incident.incidentId}-${version.slice(0, 12).toUpperCase()}`;
}
