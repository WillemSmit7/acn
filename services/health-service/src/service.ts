import type { Device, HealthCheckResult, NetworkEvent } from './models/types.js';
import type { AppConfig } from './config/env.js';
import type { Logger } from './logger.js';
import type { AcnRepository } from './firebase/repository.js';
import { checkAll } from './checks/healthCheck.js';
import { StateTracker, transitionToEvent } from './checks/stateTracker.js';

export interface RoundSummary {
  results: HealthCheckResult[];
  events: NetworkEvent[];
}

/**
 * The Health Service: periodically probe every enabled device, persist each
 * result, and emit a network event whenever a device changes state.
 *
 * The loop is deliberately hard to kill. A failed check becomes a "down"
 * result rather than an exception, and a Firestore outage is logged and
 * skipped rather than propagated - observation must survive the failure of
 * everything layered on top of it.
 */
export class HealthService {
  private readonly tracker = new StateTracker();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly devices: Device[],
    private readonly config: AppConfig,
    private readonly repository: AcnRepository,
    private readonly logger: Logger,
  ) {}

  /** Run a single check round: probe, log, persist, emit events. */
  async runOnce(): Promise<RoundSummary> {
    const results = await checkAll(this.devices, {
      count: this.config.pingCount,
      timeoutSeconds: this.config.checkTimeoutSeconds,
    });

    for (const result of results) {
      this.logger.line(formatResult(result));
    }

    const events = this.tracker
      .observeAll(results)
      .map(transitionToEvent)
      .filter((event): event is NetworkEvent => event !== null);

    for (const event of events) {
      const label = event.eventType.toUpperCase();
      this.logger.warn(`EVENT ${label} device=${event.deviceId} severity=${event.severity}`);
    }

    await this.persist(results, events);
    return { results, events };
  }

  /**
   * Persist a round. Health checks and events are written independently so a
   * failure on one does not discard the other.
   */
  private async persist(results: HealthCheckResult[], events: NetworkEvent[]): Promise<void> {
    try {
      const written = await this.repository.saveHealthChecks(results);
      this.logger.debug(`Wrote ${written} healthCheck document(s)`);
    } catch (error) {
      this.logger.error(`Failed to write healthChecks: ${describe(error)}`);
    }

    if (events.length === 0) return;

    try {
      const written = await this.repository.saveNetworkEvents(events);
      this.logger.info(`Wrote ${written} networkEvent document(s)`);
    } catch (error) {
      this.logger.error(`Failed to write networkEvents: ${describe(error)}`);
    }
  }

  /** Start the periodic loop. Returns once the first round has completed. */
  async start(): Promise<void> {
    this.logger.info(
      `Monitoring ${this.devices.length} device(s) every ${this.config.checkIntervalSeconds}s`,
    );

    await this.tick();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, this.config.checkIntervalSeconds * 1000);

    // Do not keep the process alive purely for the next tick during shutdown.
    this.timer.unref?.();
    this.timer.ref();
  }

  /** One guarded iteration. Overlapping rounds are skipped, never queued. */
  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('Previous check round still running - skipping this interval');
      return;
    }

    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      // Last line of defence: the loop must never die.
      this.logger.error(`Check round failed: ${describe(error)}`);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.logger.info('Health Service stopped');
  }
}

/**
 * Container-to-container RTT in the lab is routinely under 0.1ms, so a fixed
 * single decimal would render every healthy check as a misleading "0.0ms".
 * Scale the precision to the magnitude instead.
 */
function formatLatency(latencyMs: number | null): string {
  if (latencyMs === null) return 'n/a';
  return `${latencyMs.toFixed(latencyMs < 1 ? 3 : 1)}ms`;
}

function formatResult(result: HealthCheckResult): string {
  const device = result.deviceId.padEnd(4);
  if (result.status === 'healthy') {
    return `${device} healthy ${formatLatency(result.latencyMs)}`;
  }
  return `${device} DOWN    ${result.error ?? ''}`.trimEnd();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
