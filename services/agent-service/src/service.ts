import type { AppConfig } from './config/env.js';
import { PROMPT_VERSION, buildPrompt } from './investigation/prompt.js';
import { diagnosisVersion, runIdFor } from './investigation/version.js';
import type { Logger } from './logger.js';
import type {
  AgentConclusion,
  AgentRepositoryPort,
  InvestigableIncident,
  InvestigatorClient,
} from './models/types.js';

/** Failure-isolated, one-at-a-time incident investigation queue. */
export class AgentService {
  private unsubscribe: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly active = new Set<string>();
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: AgentRepositoryPort,
    private readonly client: InvestigatorClient,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.logger.info(
      `Watching settled incidents with ${this.config.model} ` +
      `(reasoning=${this.config.reasoningEffort})`,
    );
    this.unsubscribe = this.repository.watchIncidents((incidents) => {
      for (const incident of incidents) this.enqueue(incident);
    });
  }

  private enqueue(incident: InvestigableIncident): void {
    if (this.stopped) return;
    const version = diagnosisVersion(incident.rootCause);
    const runId = runIdFor(incident, version);
    if (this.active.has(runId)) return;
    this.active.add(runId);

    this.queue = this.queue
      .then(() => this.investigate(incident, version, runId))
      .catch((error) => this.logger.error(`Agent queue failed: ${describe(error)}`))
      .finally(() => this.active.delete(runId));
  }

  private async investigate(
    incident: InvestigableIncident,
    version: string,
    runId: string,
  ): Promise<void> {
    let claimed = false;
    const started = performance.now();
    try {
      claimed = await this.repository.claimRun({
        runId,
        diagnosisVersion: version,
        incident,
        model: this.config.model,
        reasoningEffort: this.config.reasoningEffort,
        promptVersion: PROMPT_VERSION,
      });
      if (!claimed) {
        this.logger.debug(`${runId} already exists; skipping`);
        return;
      }

      this.logger.line(`${runId} COLLECTING ${incident.incidentId}`);
      const evidence = await this.repository.loadEvidence(incident.eventIds);
      const prompt = buildPrompt(incident, evidence);
      await this.repository.markAnalyzing(runId, evidence, prompt);

      this.logger.line(
        `${runId} ANALYZING  ${evidence.events.length} event(s), ${evidence.logs.length} raw log(s)`,
      );
      const result = await this.client.investigate(prompt);
      validateCitations(
        result.conclusion,
        evidence.events.map((event) => event.id),
        evidence.logs.map((log) => log.id),
      );
      const agreement = agrees(incident, result.conclusion) ? 'agree' : 'disagree';
      await this.repository.completeRun(runId, { ...result, agreement });

      this.logger.line(
        `${runId} COMPLETED   ${result.conclusion.summary} (${agreement}, ` +
        `$${result.estimatedCostUsd.toFixed(6)}, ${result.latencyMs}ms)`,
      );
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      this.logger.error(`${runId} failed: ${describe(error)}`);
      if (claimed) {
        try {
          await this.repository.failRun(runId, error, latencyMs);
        } catch (writeError) {
          this.logger.error(`${runId} failure could not be recorded: ${describe(writeError)}`);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    await this.queue;
    this.logger.info('Agent Service stopped');
  }
}

export function agrees(incident: InvestigableIncident, conclusion: AgentConclusion): boolean {
  return incident.rootCause.type === conclusion.rootCauseType &&
    sameStrings(incident.rootCause.devices, conclusion.rootCauseDevices);
}

export function validateCitations(
  conclusion: AgentConclusion,
  eventIds: string[],
  logIds: string[],
): void {
  if (conclusion.citedEventIds.length === 0) throw new Error('Model cited no events');
  const availableEvents = new Set(eventIds);
  const availableLogs = new Set(logIds);
  for (const id of conclusion.citedEventIds) {
    if (!availableEvents.has(id)) throw new Error(`Model cited unknown event id ${id}`);
  }
  for (const id of conclusion.citedLogIds) {
    if (!availableLogs.has(id)) throw new Error(`Model cited unknown log id ${id}`);
  }
  if (logIds.length > 0 && conclusion.citedLogIds.length === 0) {
    throw new Error('Model cited no raw logs although raw log evidence was supplied');
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
