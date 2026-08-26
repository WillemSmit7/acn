import type { ScenarioDefinition, ScenarioId } from './scenarios.js';

export type ActionStatus = 'running' | 'completed' | 'failed';

export interface LabAction {
  id: string;
  scenario: ScenarioId;
  label: string;
  status: ActionStatus;
  output: string[];
  requestedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface ActionRepositoryPort {
  create(action: LabAction): Promise<void>;
  updateOutput(action: LabAction): Promise<void>;
  finish(action: LabAction): Promise<void>;
}

export interface ScenarioRunnerPort {
  run(scenario: ScenarioDefinition, onLine: (line: string) => Promise<void>): Promise<number>;
  stop(): void;
}
