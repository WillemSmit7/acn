export const REMEDIATION_TOOLS = [
  'restore_ospf_cost',
  'restore_ospf_adjacency',
  'enable_interface',
  'restart_routing_service',
  'restore_resource_profile',
  'escalate_no_safe_action',
] as const;

export type RemediationTool = typeof REMEDIATION_TOOLS[number];
export type Risk = 'none' | 'medium' | 'high';
export type ActionStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'escalated';

export interface ToolDefinition {
  tool: RemediationTool;
  description: string;
  target: { deviceId: 'r2' | 'r3'; component: string } | null;
  risk: Risk;
  mutating: boolean;
  approvalRequired: boolean;
  expectedRecoveryEvent: string | null;
}

export interface ActionProposal {
  incidentId: string;
  agentRunId: string;
  tool: RemediationTool;
  rationale: string;
  citedEvidenceIds: string[];
}

export interface GuardResult {
  allowed: boolean;
  reason: string;
  incidentVersion: string | null;
}

export interface PreflightResult {
  satisfied: boolean;
  reason: string;
  stateDigest: string;
  snapshot: Record<string, unknown>;
}

export interface VerificationResult {
  recovered: boolean;
  reason: string;
  evidenceIds: string[];
  snapshot: Record<string, unknown>;
}

export interface AgentAction extends ActionProposal {
  actionId: string;
  idempotencyKey: string;
  target: ToolDefinition['target'];
  risk: Risk;
  approvalRequired: boolean;
  status: ActionStatus;
  incidentVersion: string | null;
  approvedBy: string | null;
  preflight: PreflightResult | null;
  verification: VerificationResult | null;
  error: string | null;
}

export interface AuditEvent {
  actionId: string;
  incidentId: string;
  actor: 'ai' | 'human' | 'policy' | 'controller' | 'observer';
  transition: string;
  reason: string;
}

export interface ActionRepositoryPort {
  createOrGet(action: AgentAction, audit: AuditEvent): Promise<{ action: AgentAction; created: boolean }>;
  get(actionId: string): Promise<AgentAction | null>;
  transition(
    actionId: string,
    allowedFrom: ActionStatus[],
    patch: Partial<AgentAction>,
    audit: AuditEvent,
  ): Promise<AgentAction>;
}

export interface IncidentGuardPort {
  validate(proposal: ActionProposal): Promise<GuardResult>;
}

export interface RemediationExecutorPort {
  preflight(tool: RemediationTool): Promise<PreflightResult>;
  execute(tool: RemediationTool): Promise<void>;
  verify(action: AgentAction): Promise<VerificationResult>;
}
