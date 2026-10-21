import {
  REMEDIATION_TOOLS,
  type ActionProposal,
  type RemediationTool,
  type ToolDefinition,
} from './types.js';

export const TOOL_CATALOG: Readonly<Record<RemediationTool, ToolDefinition>> = {
  restore_ospf_cost: {
    tool: 'restore_ospf_cost', description: 'Restore the intended OSPF cost on R2 eth2.',
    target: { deviceId: 'r2', component: 'eth2 ospf cost' }, risk: 'medium',
    mutating: true, approvalRequired: true, expectedRecoveryEvent: 'configuration_restored',
  },
  restore_ospf_adjacency: {
    tool: 'restore_ospf_adjacency', description: 'Remove unintended passive mode from R2 eth2.',
    target: { deviceId: 'r2', component: 'eth2 ospf adjacency' }, risk: 'medium',
    mutating: true, approvalRequired: true, expectedRecoveryEvent: 'routing_session_up',
  },
  enable_interface: {
    tool: 'enable_interface', description: 'Administratively enable R2 eth2.',
    target: { deviceId: 'r2', component: 'eth2 admin state' }, risk: 'high',
    mutating: true, approvalRequired: true, expectedRecoveryEvent: 'interface_admin_up',
  },
  restart_routing_service: {
    tool: 'restart_routing_service', description: 'Restore the R3 OSPF routing service.',
    target: { deviceId: 'r3', component: 'ospfd' }, risk: 'high',
    mutating: true, approvalRequired: true, expectedRecoveryEvent: 'routing_service_up',
  },
  restore_resource_profile: {
    tool: 'restore_resource_profile', description: 'Restore the approved R3 CPU profile.',
    target: { deviceId: 'r3', component: 'cpu profile' }, risk: 'high',
    mutating: true, approvalRequired: true, expectedRecoveryEvent: 'resource_recovered',
  },
  escalate_no_safe_action: {
    tool: 'escalate_no_safe_action', description: 'Record that no allow-listed repair is safe.',
    target: null, risk: 'none', mutating: false, approvalRequired: false,
    expectedRecoveryEvent: null,
  },
};

export function parseProposal(value: unknown): ActionProposal {
  if (!isObject(value)) throw new Error('proposal must be an object');
  assertExactKeys(value, ['incidentId', 'agentRunId', 'tool', 'rationale', 'citedEvidenceIds']);
  const incidentId = identifier(value['incidentId'], 'incidentId');
  const agentRunId = identifier(value['agentRunId'], 'agentRunId');
  const tool = value['tool'];
  if (typeof tool !== 'string' || !REMEDIATION_TOOLS.includes(tool as RemediationTool)) {
    throw new Error('tool is not allow-listed');
  }
  const rationale = value['rationale'];
  if (typeof rationale !== 'string' || rationale.length < 1 || rationale.length > 1_000) {
    throw new Error('rationale must contain 1 to 1000 characters');
  }
  const citedEvidenceIds = value['citedEvidenceIds'];
  if (!Array.isArray(citedEvidenceIds) || citedEvidenceIds.length < 1 || citedEvidenceIds.length > 20 ||
      !citedEvidenceIds.every((id) => typeof id === 'string' && validIdentifier(id))) {
    throw new Error('citedEvidenceIds must contain 1 to 20 valid ids');
  }
  return { incidentId, agentRunId, tool: tool as RemediationTool, rationale, citedEvidenceIds };
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !validIdentifier(value)) throw new Error(`${field} is invalid`);
  return value;
}

function validIdentifier(value: string): boolean {
  return value.length <= 160 && /^[A-Za-z0-9:_-]+$/.test(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`unexpected proposal field: ${unexpected[0]}`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`missing proposal field: ${missing[0]}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
