import { basename, dirname, resolve } from 'node:path';

export type ScenarioId = 'link-failure' | 'router-failure' | 'restore';

export interface ScenarioDefinition {
  id: ScenarioId;
  label: string;
  description: string;
  tone: 'danger' | 'restore';
  scriptPath: string;
}

const workingDirectory = process.cwd();
const repoRoot =
  basename(workingDirectory) === 'lab-controller' && basename(dirname(workingDirectory)) === 'services'
    ? resolve(workingDirectory, '../..')
    : workingDirectory;

export const SCENARIOS: Readonly<Record<ScenarioId, ScenarioDefinition>> = {
  'link-failure': {
    id: 'link-failure',
    label: 'Break R2–R3 link',
    description: 'Administratively shuts R2 eth2; r3 and pc2 should become unreachable.',
    tone: 'danger',
    scriptPath: resolve(repoRoot, 'lab/scenarios/01-link-failure.sh'),
  },
  'router-failure': {
    id: 'router-failure',
    label: 'Stop R3 router',
    description: 'Stops the R3 container; r3 and pc2 show the same ICMP symptoms.',
    tone: 'danger',
    scriptPath: resolve(repoRoot, 'lab/scenarios/02-router-failure.sh'),
  },
  restore: {
    id: 'restore',
    label: 'Restore network',
    description: 'Starts stopped nodes, restores links and waits for OSPF convergence.',
    tone: 'restore',
    scriptPath: resolve(repoRoot, 'lab/scenarios/03-restore-network.sh'),
  },
};

export function isScenarioId(value: string): value is ScenarioId {
  return value === 'link-failure' || value === 'router-failure' || value === 'restore';
}
