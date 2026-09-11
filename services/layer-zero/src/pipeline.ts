import type { AppConfig } from './config/env.js';
import type { LogSourceConfig } from './config/sources.js';
import type { ProcessedLine, StateObservation } from './models/types.js';
import type { Logger } from './logger.js';
import type { LayerZeroRepository } from './firebase/repository.js';
import { LogTail } from './collector/logTail.js';
import { parseFrrLine } from './normalize/parser.js';
import { normalize } from './normalize/rules.js';

/**
 * Layer 0: tail every configured device log, normalize what can be normalized,
 * and persist both halves.
 *
 * Lines are buffered briefly and flushed as one batch rather than written
 * individually. A single link failure produces a burst of dozens of lines
 * across three routers within a second or two, and a per-line round trip would
 * turn that burst into dozens of sequential commits.
 *
 * The same failure-isolation discipline as the Health Service applies here: a
 * line that cannot be parsed, a rule that throws, or a Firestore outage must
 * never stop collection (security rule 8).
 */
export class LayerZeroPipeline {
  private readonly tails: LogTail[] = [];
  private pending: ProcessedLine[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private stopped = false;

  /** Counters for the end-of-run summary and for tests. */
  private linesSeen = 0;
  private eventsEmitted = 0;

  constructor(
    private readonly sources: LogSourceConfig[],
    private readonly config: AppConfig,
    private readonly repository: LayerZeroRepository,
    private readonly logger: Logger,
  ) {}

  start(): void {
    for (const source of this.sources) {
      const tail = new LogTail(
        {
          deviceId: source.deviceId,
          containerName: source.containerName,
          logPaths: source.logPaths,
          dockerBinary: this.config.dockerBinary,
          restartDelayMs: this.config.restartDelayMs,
        },
        (line) => this.handleLine(source, line),
        this.logger,
      );
      tail.start();
      this.tails.push(tail);
    }

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);

    this.logger.info(
      `Collecting logs from ${this.sources.length} device(s): ${this.sources
        .map((source) => source.deviceId)
        .join(', ')}`,
    );
  }

  /**
   * Process one raw line. Deliberately synchronous and total: it classifies
   * the line and queues it, but never touches the network, so a slow or broken
   * Firestore cannot apply back-pressure to the tail.
   */
  handleLine(source: LogSourceConfig, raw: string): void {
    this.linesSeen += 1;

    const parsed = parseFrrLine(raw);
    let event: ProcessedLine['event'] = null;

    if (parsed !== null) {
      try {
        event = normalize(source.deviceId, parsed);
      } catch (error) {
        // A rule bug degrades this line to "raw only" rather than killing the
        // collector; the original text is still stored and still recoverable.
        this.logger.error(`Normalization rule failed on ${source.deviceId}: ${describe(error)}`);
        event = null;
      }
    }

    if (event !== null) {
      this.eventsEmitted += 1;
      this.logger.line(
        `EVENT ${event.eventType.toUpperCase()} device=${event.deviceId} ` +
          `severity=${event.severity} ${summarize(event.attributes)}`,
      );
    }

    this.pending.push({
      raw: { deviceId: source.deviceId, source: source.source, raw },
      parsed,
      event,
    });
  }

  /**
   * Queue a transition independently discovered by the read-only state
   * observer. Its exact command output is retained as evidence just like an
   * FRR line, but no synthetic line is written into the device log.
   */
  handleObservation(observation: StateObservation): void {
    this.linesSeen += 1;
    this.eventsEmitted += 1;

    const event: ProcessedLine['event'] = {
      deviceId: observation.deviceId,
      eventType: observation.eventType,
      severity: observation.severity,
      attributes: observation.attributes,
      source: 'layer-zero',
      occurredAt: observation.observedAt,
    };

    this.logger.line(
      `EVENT ${event.eventType.toUpperCase()} device=${event.deviceId} ` +
        `severity=${event.severity} ${summarize(event.attributes)}`,
    );

    this.pending.push({
      raw: {
        deviceId: observation.deviceId,
        source: 'state-observer',
        raw: observation.raw,
      },
      parsed: {
        loggedAt: observation.observedAt,
        daemon: 'ACNOBS',
        code: 'STATE-00001',
        errorCode: null,
        message: `${observation.eventType} ${summarize(observation.attributes)}`.trim(),
      },
      event,
    });
  }

  /**
   * Write everything buffered. Overlapping flushes are skipped rather than
   * queued, so a slow commit cannot pile up concurrent batches.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;

    this.flushing = true;
    const batch = this.pending;
    this.pending = [];

    try {
      await this.repository.saveProcessedLines(batch);
    } catch (error) {
      // Matching the Health Service: a database outage loses writes but never
      // stops observation. The lines are dropped rather than retried forever,
      // which would grow without bound while Firestore stayed down.
      this.logger.error(`Failed to write ${batch.length} line(s): ${describe(error)}`);
    } finally {
      this.flushing = false;
    }
  }

  stats(): { linesSeen: number; eventsEmitted: number } {
    return { linesSeen: this.linesSeen, eventsEmitted: this.eventsEmitted };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    for (const tail of this.tails) tail.stop();
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer);

    // Drain whatever was collected between the last tick and shutdown.
    await this.flush();

    const { linesSeen, eventsEmitted } = this.stats();
    this.logger.info(
      `Layer 0 stopped - ${linesSeen} line(s) collected, ${eventsEmitted} event(s) emitted`,
    );
  }
}

/** Compact one-line rendering of an event's attributes for the console. */
function summarize(attributes: Record<string, unknown>): string {
  const iface = attributes['interface'];
  const neighbor = attributes['neighborId'];

  const parts: string[] = [];
  if (typeof iface === 'string') parts.push(`interface=${iface}`);
  if (typeof neighbor === 'string') parts.push(`neighbor=${neighbor}`);
  return parts.join(' ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
