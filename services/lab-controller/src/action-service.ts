import { randomUUID } from 'node:crypto';
import { SCENARIOS, type ScenarioId } from './scenarios.js';
import type { ActionRepositoryPort, LabAction, ScenarioRunnerPort } from './types.js';

export class ActionBusyError extends Error {}

export class LabActionService {
  private current: LabAction | null = null;
  private activeTask: Promise<void> | null = null;

  constructor(
    private readonly repository: ActionRepositoryPort,
    private readonly runner: ScenarioRunnerPort,
    private readonly log: (message: string) => void = console.log,
  ) {}

  status(): { busy: boolean; current: LabAction | null } {
    return { busy: this.current !== null, current: this.current };
  }

  async trigger(scenarioId: ScenarioId): Promise<LabAction> {
    if (this.current !== null) {
      throw new ActionBusyError(`${this.current.label} is already running`);
    }

    const scenario = SCENARIOS[scenarioId];
    const action: LabAction = {
      id: `LAB-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      scenario: scenario.id,
      label: scenario.label,
      status: 'running',
      output: [],
      requestedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      error: null,
    };

    this.current = action;
    try {
      await this.repository.create(action);
    } catch (error) {
      this.current = null;
      throw error;
    }

    this.log(`${action.id} START ${action.label}`);
    this.activeTask = this.execute(action).finally(() => {
      this.current = null;
      this.activeTask = null;
    });
    return action;
  }

  async stop(): Promise<void> {
    this.runner.stop();
    await this.activeTask;
  }

  private async execute(action: LabAction): Promise<void> {
    const scenario = SCENARIOS[action.scenario];
    try {
      const exitCode = await this.runner.run(scenario, async (line) => {
        action.output = [...action.output, line].slice(-100);
        await this.repository.updateOutput(action);
      });
      action.exitCode = exitCode;
      action.completedAt = new Date().toISOString();
      if (exitCode === 0) {
        action.status = 'completed';
        this.log(`${action.id} COMPLETE ${action.label}`);
      } else {
        action.status = 'failed';
        action.error = `Scenario exited with code ${exitCode}`;
        this.log(`${action.id} FAILED ${action.error}`);
      }
    } catch (error) {
      action.status = 'failed';
      action.completedAt = new Date().toISOString();
      action.error = error instanceof Error ? error.message : String(error);
      this.log(`${action.id} FAILED ${action.error}`);
    }

    try {
      const groundTruth = action.status === 'completed' ? scenario.groundTruth : undefined;
      await this.repository.finish(action, groundTruth);
    } catch (error) {
      this.log(`${action.id} could not persist completion: ${String(error)}`);
    }
  }
}
