import type { AppConfig } from './config/env.js';
import type { Incident, ObservedEvent } from './models/types.js';
import type { Logger } from './logger.js';
import type { IncidentRepository } from './firebase/repository.js';
import { Correlator } from './correlation/correlator.js';

/**
 * The Incident Service: watch normalized events, group related ones into
 * incidents, infer a probable root cause, and close incidents when everything
 * they cover has recovered.
 *
 * Same failure-isolation discipline as the layers below it (security rule 8):
 * a malformed event, a correlation bug or a Firestore outage must not stop the
 * service from observing. Correlation sits above monitoring and must never be
 * able to take it down.
 */
export class IncidentService {
  private readonly correlator: Correlator;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private flushing = false;
  private stopped = false;
  /**
   * Last root-cause summary printed per incident. The full evidence block is
   * worth reading once; repeating it on every recovery event turns the log into
   * noise and hides the transitions that matter.
   */
  private readonly reported = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: IncidentRepository,
    private readonly logger: Logger,
  ) {
    this.correlator = new Correlator({
      correlationWindowMs: config.correlationWindowMs,
      settleMs: config.settleMs,
    });
  }

  async start(): Promise<void> {
    try {
      const highest = await this.repository.highestIncidentNumber();
      this.correlator.seedSequence(highest);
      if (highest > 0) this.logger.info(`Continuing incident numbering from INC-${highest}`);
    } catch (error) {
      // Not fatal - worst case an id is reused, which is better than refusing
      // to correlate at all.
      this.logger.warn(`Could not read existing incidents: ${describe(error)}`);
    }

    const since = this.config.replayHistory ? new Date(0) : new Date();
    this.logger.info(
      this.config.replayHistory
        ? 'Replaying all existing networkEvents'
        : 'Watching networkEvents from now',
    );

    this.unsubscribe = this.repository.watchEvents(since, (events) => {
      this.ingest(events);
    });

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.tickIntervalMs);

    this.logger.info(
      `Correlating with a ${this.config.correlationWindowMs / 1000}s window, ` +
        `${this.config.settleMs / 1000}s settle`,
    );
  }

  /** Feed a batch of events into the correlator. Never throws. */
  ingest(events: ObservedEvent[]): void {
    for (const event of events) {
      try {
        const incident = this.correlator.observe(event);
        if (incident !== null) {
          this.logger.debug(
            `${incident.incidentId} <- ${event.eventType} ${event.deviceId} (${event.source})`,
          );
        }
      } catch (error) {
        this.logger.error(`Correlation failed for event ${event.id}: ${describe(error)}`);
      }
    }
    // Persist readiness invalidation promptly when new fault evidence lands;
    // the periodic tick remains the fallback if a write is already in flight.
    void this.tick();
  }

  /** One evaluation pass: settle root causes, close incidents, persist changes. */
  async tick(): Promise<void> {
    if (this.flushing || this.stopped) return;
    this.flushing = true;

    try {
      const changed = this.correlator.tick(new Date());
      if (changed.length === 0) return;

      for (const incident of changed) this.report(incident);

      try {
        await this.repository.saveIncidents(changed);
      } catch (error) {
        this.logger.error(`Failed to write ${changed.length} incident(s): ${describe(error)}`);
      }
    } catch (error) {
      this.logger.error(`Incident tick failed: ${describe(error)}`);
    } finally {
      this.flushing = false;
    }
  }

  private report(incident: Incident): void {
    if (incident.status === 'resolved') {
      this.reported.delete(incident.incidentId);
      this.logger.line(`${incident.incidentId} RESOLVED  ${incident.rootCause.summary}`);
      return;
    }

    if (incident.rootCause.type === 'analyzing') {
      this.logger.line(
        `${incident.incidentId} OPEN      correlating ${incident.eventCount} event(s) ` +
          `on ${incident.affectedDevices.join(', ')}`,
      );
      return;
    }

    const { rootCause } = incident;
    const signature = `${rootCause.type}:${rootCause.summary}:${rootCause.confidence}`;

    if (this.reported.get(incident.incidentId) === signature) {
      // Same conclusion as last time - just show what is still outstanding.
      this.logger.line(
        `${incident.incidentId} OPEN      ${incident.eventCount} event(s), ` +
          `still unreachable: ${format(incident.unreachableDevices)}`,
      );
      return;
    }
    this.reported.set(incident.incidentId, signature);

    this.logger.line(
      `${incident.incidentId} ${incident.severity.toUpperCase().padEnd(9)} ${rootCause.summary} ` +
        `(${rootCause.confidence})`,
    );
    for (const line of rootCause.evidence) this.logger.line(`             - ${line}`);
    this.logger.line(
      `             predicted unreachable: ${format(rootCause.predictedUnreachable)} | ` +
        `observed: ${format(rootCause.observedUnreachable)} | ` +
        `${rootCause.predictionMatches ? 'MATCH' : 'MISMATCH'}`,
    );
  }

  /** Force a final evaluation, used by the end-to-end test before asserting. */
  async drain(): Promise<void> {
    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.unsubscribe !== undefined) this.unsubscribe();
    if (this.timer !== undefined) clearInterval(this.timer);

    this.stopped = false;
    await this.tick();
    this.stopped = true;

    this.logger.info('Incident Service stopped');
  }
}

function format(devices: string[]): string {
  return devices.length === 0 ? 'none' : devices.join(', ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
