import { createHash } from 'node:crypto';
import type { InvestigableIncident } from '../models/types.js';

/** One blind investigation per incident and prompt contract, independent of any baseline diagnosis. */
export function diagnosisVersion(incidentId: string, promptVersion: string): string {
  const canonical = JSON.stringify({ incidentId, promptVersion });
  return createHash('sha256').update(canonical).digest('hex');
}

export function runIdFor(incident: InvestigableIncident, version: string): string {
  return `RUN-${incident.incidentId}-${version.slice(0, 12).toUpperCase()}`;
}
