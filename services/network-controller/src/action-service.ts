import { parseProposal, TOOL_CATALOG } from "./tool-catalog.js";
import { actionIdFor, proposalKeyFor } from "./proposal-identity.js";
import type {
  ActionRepositoryPort,
  AgentAction,
  AuditEvent,
  RemediationExecutorPort,
} from "./types.js";

export class ApprovalRequiredError extends Error {}

export class GuardedActionService {
  constructor(
    private readonly repository: ActionRepositoryPort,
    private readonly executor: RemediationExecutorPort,
  ) {}

  async propose(input: unknown): Promise<AgentAction> {
    const proposal = parseProposal(input);
    const definition = TOOL_CATALOG[proposal.tool];
    const idempotencyKey = proposalKeyFor(proposal);
    const action: AgentAction = {
      ...proposal,
      actionId: actionIdFor(proposal),
      idempotencyKey,
      target: definition.target,
      risk: definition.risk,
      approvalRequired: definition.approvalRequired,
      status:
        proposal.tool === "escalate_no_safe_action" ? "escalated" : "proposed",
      approvedBy: null,
      approvedAt: null,
      preflight: null,
      verification: null,
      error: null,
      createdAt: null,
      updatedAt: null,
    };
    const created = await this.repository.createOrGet(
      action,
      audit(action, "ai", action.status, proposal.rationale),
    );
    return created.action;
  }

  async approve(actionId: string, approver: string): Promise<AgentAction> {
    if (!validApprover(approver)) throw new Error("approver is invalid");
    const current = await this.requiredAction(actionId);
    if (!current.approvalRequired)
      throw new ApprovalRequiredError("action does not require approval");
    if (current.status !== "proposed") {
      if (current.status === "approved" && current.approvedBy === approver) {
        return this.execute(current);
      }
      if (current.approvedBy === approver) return current;
      throw new ApprovalRequiredError(
        `action cannot be approved from ${current.status}`,
      );
    }

    const approved = await this.repository.transition(
      actionId,
      ["proposed"],
      {
        status: "approved",
        approvedBy: approver,
      },
      audit(current, "human", "approved", `approved by ${approver}`),
    );
    return this.execute(approved);
  }

  async reject(
    actionId: string,
    approver: string,
    reason: string,
  ): Promise<AgentAction> {
    if (
      !validApprover(approver) ||
      reason.trim().length === 0 ||
      reason.length > 500
    ) {
      throw new Error("valid approver and rejection reason are required");
    }
    const current = await this.requiredAction(actionId);
    return this.repository.transition(
      actionId,
      ["proposed"],
      {
        status: "rejected",
        approvedBy: approver,
        error: reason,
      },
      audit(current, "human", "rejected", reason),
    );
  }

  private async execute(action: AgentAction): Promise<AgentAction> {
    const executing = await this.repository.transition(
      action.actionId,
      ["approved"],
      {
        status: "executing",
      },
      audit(
        action,
        "controller",
        "executing",
        "human approval recorded; running fixed preflight guards",
      ),
    );

    try {
      const preflight = await this.executor.preflight(executing);
      await this.executor.execute(executing);
      const verifying = await this.repository.transition(
        action.actionId,
        ["executing"],
        {
          status: "verifying",
          preflight,
        },
        audit(
          action,
          "controller",
          "verifying",
          "fixed operation completed; awaiting recovery evidence",
        ),
      );
      return this.finishVerification(verifying);
    } catch (error) {
      const failed = await this.repository.transition(
        action.actionId,
        ["executing", "verifying"],
        {
          status: "failed",
          error: describe(error),
        },
        audit(action, "controller", "failed", describe(error)),
      );
      return this.escalateFailure(failed, describe(error));
    }
  }

  private async finishVerification(action: AgentAction): Promise<AgentAction> {
    const verification = await this.executor.verify(action);
    const completed = await this.repository.transition(
      action.actionId,
      ["verifying"],
      {
        status: verification.recovered ? "succeeded" : "failed",
        verification,
        error: verification.recovered ? null : verification.reason,
      },
      audit(
        action,
        verification.recovered ? "observer" : "controller",
        verification.recovered ? "succeeded" : "failed",
        verification.reason,
      ),
    );
    return completed.status === "failed"
      ? this.escalateFailure(completed, verification.reason)
      : completed;
  }

  private async escalateFailure(action: AgentAction, reason: string): Promise<AgentAction> {
    return this.repository.transition(
      action.actionId,
      ["failed"],
      { status: "escalated", error: reason },
      audit(action, "policy", "escalated", reason),
    );
  }

  private async requiredAction(actionId: string): Promise<AgentAction> {
    const action = await this.repository.get(actionId);
    if (action === null) throw new Error("action not found");
    return action;
  }

  async list(): Promise<AgentAction[]> {
    return this.repository.list();
  }

  async get(actionId: string): Promise<AgentAction | null> {
    return this.repository.get(actionId);
  }

  /** Resume only actions that are known not to have started mutating. */
  async resumeApproved(): Promise<void> {
    const actions = await this.repository.list();
    for (const action of actions.filter((candidate) =>
      candidate.status === "approved" || candidate.status === "executing" ||
      candidate.status === "verifying")) {
      try {
        if (action.status === "approved") await this.execute(action);
        if (action.status === "verifying") await this.finishVerification(action);
        if (action.status === "executing") {
          const reason = "controller restarted during execution; outcome requires operator review";
          const failed = await this.repository.transition(action.actionId, ["executing"], {
            status: "failed", error: reason,
          }, audit(action, "controller", "failed", reason));
          await this.escalateFailure(failed, reason);
        }
      } catch {
        // Recovery is best-effort and never prevents other actions from loading.
      }
    }
  }
}

function audit(
  action: Pick<AgentAction, "actionId" | "incidentId">,
  actor: AuditEvent["actor"],
  transition: string,
  reason: string,
): AuditEvent {
  return {
    actionId: action.actionId,
    incidentId: action.incidentId,
    actor,
    transition,
    reason,
  };
}

function validApprover(value: string): boolean {
  return (
    value.length >= 2 && value.length <= 80 && /^[A-Za-z0-9@._ -]+$/.test(value)
  );
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown controller failure").slice(0, 300);
}
