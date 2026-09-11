import { basename, dirname, resolve } from 'node:path';

export type FailureScenarioId =
  | 'configuration-drift'
  | 'routing-session-failure'
  | 'interface-disabled'
  | 'routing-service-crash'
  | 'resource-exhaustion';
export type ScenarioId = FailureScenarioId | 'restore';

export type EvaluationRootCauseType =
  | 'configuration_drift'
  | 'routing_session_failure'
  | 'interface_misconfiguration'
  | 'routing_service_failure'
  | 'resource_exhaustion';

export interface LabGroundTruth {
  rootCauseType: EvaluationRootCauseType;
  rootCauseDevices: string[];
}

export interface ScenarioDefinition {
  id: ScenarioId;
  label: string;
  description: string;
  tone: 'danger' | 'restore';
  scriptPath: string;
  groundTruth?: LabGroundTruth;
}

const workingDirectory = process.cwd();
const repoRoot =
  basename(workingDirectory) === 'lab-controller' && basename(dirname(workingDirectory)) === 'services'
    ? resolve(workingDirectory, '../..')
    : workingDirectory;

export const SCENARIOS: Readonly<Record<ScenarioId, ScenarioDefinition>> = {
  'configuration-drift': {
    id: 'configuration-drift',
    label: 'Introduce config drift',
    description: 'Changes the intended OSPF cost on R2 eth2 and verifies the drift.',
    tone: 'danger',
    scriptPath: resolve(repoRoot, 'lab/scenarios/01-configuration-drift.sh'),
    groundTruth: { rootCauseType: 'configuration_drift', rootCauseDevices: ['r2'] },
  },
  'routing-session-failure': {
    id: 'routing-session-failure',
    label: 'Break OSPF session',
    description: 'Makes R2 eth2 passive in OSPF while the interface remains up.',
    tone: 'danger',
    scriptPath: resolve(repoRoot, 'lab/scenarios/02-routing-session-failure.sh'),
    groundTruth: { rootCauseType: 'routing_session_failure', rootCauseDevices: ['r2'] },
  },
  'interface-disabled': {
    id: 'interface-disabled',
    label: 'Disable R2 eth2',
    description: 'Administratively disables the R2 logical port toward R3.',
    tone: 'danger',
    scriptPath: resolve(repoRoot, 'lab/scenarios/03-interface-disabled.sh'),
    groundTruth: { rootCauseType: 'interface_misconfiguration', rootCauseDevices: ['r2'] },
  },
  'routing-service-crash': {
    id: 'routing-service-crash',
    label: 'Stop R3 ospfd',
    description: 'Stops only the OSPF daemon while the R3 router remains alive.',
    tone: 'danger',
    scriptPath: resolve(repoRoot, 'lab/scenarios/04-routing-service-crash.sh'),
    groundTruth: { rootCauseType: 'routing_service_failure', rootCauseDevices: ['r3'] },
  },
  'resource-exhaustion': {
    id: 'resource-exhaustion',
    label: 'Exhaust R3 control-plane CPU',
    description: 'Applies bounded CPU pressure that starves the R3 OSPF service.',
    tone: 'danger',
    scriptPath: resolve(repoRoot, 'lab/scenarios/05-resource-exhaustion.sh'),
    groundTruth: { rootCauseType: 'resource_exhaustion', rootCauseDevices: ['r3'] },
  },
  restore: {
    id: 'restore',
    label: 'Restore network',
    description: 'Removes every injected fault and returns FRR to the intended baseline.',
    tone: 'restore',
    scriptPath: resolve(repoRoot, 'lab/scenarios/06-restore-network.sh'),
  },
};

export function isScenarioId(value: string): value is ScenarioId {
  return Object.hasOwn(SCENARIOS, value);
}
