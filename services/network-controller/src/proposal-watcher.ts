import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import type { GuardedActionService } from './action-service.js';

export class ProposalWatcher {
  private unsubscribe: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Firestore,
    private readonly service: GuardedActionService,
    private readonly log: (message: string) => void = console.log,
  ) {}

  start(): void {
    this.unsubscribe = this.db.collection('agentRuns')
      .where('status', '==', 'completed')
      .onSnapshot((snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed') continue;
          const proposal = proposalFromRun(change.doc.data());
          if (proposal === null) continue;
          this.queue = this.queue.then(async () => {
            const action = await this.service.propose(proposal);
            this.log(`${action.actionId} ${action.status.toUpperCase()} ${action.tool}`);
          }).catch((error) => {
            this.log(`Proposal persistence failed safely: ${safeError(error)}`);
          });
        }
      }, (error) => this.log(`agentRuns listener failed: ${safeError(error)}`));
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    await this.queue;
  }
}

export function proposalFromRun(data: DocumentData): unknown | null {
  const conclusion = object(data['conclusion']);
  const remediation = object(conclusion?.['remediationProposal']);
  if (conclusion === null || remediation === null || typeof data['runId'] !== 'string' ||
      typeof data['incidentId'] !== 'string') return null;
  return {
    incidentId: data['incidentId'],
    agentRunId: data['runId'],
    tool: remediation['tool'],
    rationale: remediation['rationale'],
    citedEvidenceIds: remediation['citedEvidenceIds'],
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown persistence error';
}
