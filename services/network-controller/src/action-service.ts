import { createHash } from 'node:crypto';
import { parseProposal, TOOL_CATALOG } from './tool-catalog.js';
import type {
  ActionProposal,
  ActionRepositoryPort,
  AgentAction,
  AuditEvent,
  IncidentGuardPort,
  RemediationExecutorPort,
} from './types.js';

export class GuardRejectedError extends Error {}
export class ApprovalRequiredError extends Error {}

export class GuardedActionService {
  constructor(
    private readonly repository: ActionRepositoryPort,
    private readonly incidentGuard: IncidentGuardPort,
    private readonly executor: RemediationExecutorPort,
  ) {}

  async propose(input: unknown): Promise<AgentAction> {
    const proposal = parseProposal(input);
    const guard = await this.incidentGuard.validate(proposal);
    if (!guard.allowed) throw new GuardRejectedError(guard.reason);

    const definition = TOOL_CATALOG[proposal.tool];
    const idempotencyKey = keyFor(proposal);
    const action: AgentAction = {
      ...proposal,
      actionId: `ACT-${idempotencyKey.slice(0, 16).toUpperCase()}`,
      idempotencyKey,
      target: definition.target,
      risk: definition.risk,
      approvalRequired: definition.approvalRequired,
      status: proposal.tool === 'escalate_no_safe_action' ? 'escalated' : 'proposed',
      incidentVersion: guard.incidentVersion,
      approvedBy: null,
      preflight: null,
      verification: null,
      error: null,
    };
    const created = await this.repository.createOrGet(
      action,
      audit(action, 'ai', action.status, proposal.rationale),
    );
    return created.action;
  }

  async approve(actionId: string, approver: string): Promise<AgentAction> {
    if (!validApprover(approver)) throw new Error('approver is invalid');
    const current = await this.requiredAction(actionId);
    if (!current.approvalRequired) throw new ApprovalRequiredError('action does not require approval');
    if (current.status !== 'proposed') {
      if (current.approvedBy === approver) return current;
      throw new ApprovalRequiredError(`action cannot be approved from ${current.status}`);
    }

    const guard = await this.incidentGuard.validate(current);
    if (!guard.allowed || guard.incidentVersion !== current.incidentVersion) {
      return this.repository.transition(actionId, ['proposed'], {
        status: 'failed', error: `stale proposal: ${guard.reason}`,
      }, audit(current, 'policy', 'failed', `stale proposal: ${guard.reason}`));
    }

    const approved = await this.repository.transition(actionId, ['proposed'], {
      status: 'approved', approvedBy: approver,
    }, audit(current, 'human', 'approved', `approved by ${approver}`));
    return this.execute(approved);
  }

  async reject(actionId: string, approver: string, reason: string): Promise<AgentAction> {
    if (!validApprover(approver) || reason.trim().length === 0 || reason.length > 500) {
      throw new Error('valid approver and rejection reason are required');
    }
    const current = await this.requiredAction(actionId);
    return this.repository.transition(actionId, ['proposed'], {
      status: 'rejected', approvedBy: approver, error: reason,
    }, audit(current, 'human', 'rejected', reason));
  }

  private async execute(action: AgentAction): Promise<AgentAction> {
    const executing = await this.repository.transition(action.actionId, ['approved'], {
      status: 'executing',
    }, audit(action, 'controller', 'executing', 'approval and incident guards passed'));

    try {
      const preflight = await this.executor.preflight(executing.tool);
      if (!preflight.satisfied) {
        return this.repository.transition(action.actionId, ['executing'], {
          status: 'failed', preflight, error: preflight.reason,
        }, audit(action, 'policy', 'failed', `precondition failed: ${preflight.reason}`));
      }
      await this.executor.execute(executing.tool);
      const verifying = await this.repository.transition(action.actionId, ['executing'], {
        status: 'verifying', preflight,
      }, audit(action, 'controller', 'verifying', 'fixed operation completed; awaiting recovery evidence'));
      const verification = await this.executor.verify(verifying);
      return this.repository.transition(action.actionId, ['verifying'], {
        status: verification.recovered ? 'succeeded' : 'failed',
        verification,
        error: verification.recovered ? null : verification.reason,
      }, audit(
        action,
        verification.recovered ? 'observer' : 'controller',
        verification.recovered ? 'succeeded' : 'failed',
        verification.reason,
      ));
    } catch (error) {
      const current = await this.requiredAction(action.actionId);
      return this.repository.transition(action.actionId, ['executing', 'verifying'], {
        status: 'failed', error: describe(error),
      }, audit(action, 'controller', 'failed', describe(error)));
    }
  }

  private async requiredAction(actionId: string): Promise<AgentAction> {
    const action = await this.repository.get(actionId);
    if (action === null) throw new Error('action not found');
    return action;
  }
}

function keyFor(proposal: ActionProposal): string {
  const canonical = JSON.stringify({
    incidentId: proposal.incidentId,
    agentRunId: proposal.agentRunId,
    tool: proposal.tool,
    citedEvidenceIds: [...proposal.citedEvidenceIds].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function audit(
  action: Pick<AgentAction, 'actionId' | 'incidentId'>,
  actor: AuditEvent['actor'],
  transition: string,
  reason: string,
): AuditEvent {
  return { actionId: action.actionId, incidentId: action.incidentId, actor, transition, reason };
}

function validApprover(value: string): boolean {
  return value.length >= 2 && value.length <= 80 && /^[A-Za-z0-9@._ -]+$/.test(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
