import { createHash } from 'node:crypto';
import type { ActionProposal } from './types.js';

export function proposalKeyFor(proposal: ActionProposal): string {
  const canonical = JSON.stringify({
    incidentId: proposal.incidentId,
    agentRunId: proposal.agentRunId,
    tool: proposal.tool,
    citedEvidenceIds: [...proposal.citedEvidenceIds].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function actionIdFor(proposal: ActionProposal): string {
  return `ACT-${proposalKeyFor(proposal).slice(0, 16).toUpperCase()}`;
}
