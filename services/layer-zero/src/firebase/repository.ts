import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { ProcessedLine } from '../models/types.js';
import type { Logger } from '../logger.js';

export const COLLECTIONS = {
  networkLogs: 'networkLogs',
  networkEvents: 'networkEvents',
} as const;

/**
 * Firestore limit is 500 writes per batch. One processed line can produce two
 * writes (the raw log and its event), so the chunk size is halved to keep a
 * full chunk inside the limit in the worst case.
 */
const MAX_LINES_PER_BATCH = 200;

export interface FlushResult {
  logsWritten: number;
  eventsWritten: number;
}

/** All Firestore access for Layer 0. */
export class LayerZeroRepository {
  constructor(
    private readonly db: Firestore,
    private readonly logger: Logger,
  ) {}

  /**
   * Persist a batch of processed lines.
   *
   * The raw log and the event derived from it are written in the same batch,
   * with the log's document id generated locally beforehand. That does two
   * things: the event can carry sourceLogId without a read-back round trip,
   * and the pair commits atomically - so networkEvents never contains an event
   * pointing at a networkLogs document that does not exist.
   */
  async saveProcessedLines(lines: ProcessedLine[]): Promise<FlushResult> {
    const result: FlushResult = { logsWritten: 0, eventsWritten: 0 };
    if (lines.length === 0) return result;

    for (let offset = 0; offset < lines.length; offset += MAX_LINES_PER_BATCH) {
      const chunk = lines.slice(offset, offset + MAX_LINES_PER_BATCH);
      const batch = this.db.batch();

      for (const line of chunk) {
        const logRef = this.db.collection(COLLECTIONS.networkLogs).doc();

        batch.set(logRef, {
          deviceId: line.raw.deviceId,
          source: line.raw.source,
          raw: line.raw.raw,
          // Null for lines FRR emits outside its structured format. The text is
          // kept regardless: a parser gap must stay visible and recoverable,
          // not be silently dropped.
          daemon: line.parsed?.daemon ?? null,
          code: line.parsed?.code ?? null,
          errorCode: line.parsed?.errorCode ?? null,
          message: line.parsed?.message ?? null,
          parsed: line.parsed !== null,
          normalized: line.event !== null,
          loggedAt: line.parsed === null ? null : Timestamp.fromDate(line.parsed.loggedAt),
          receivedAt: FieldValue.serverTimestamp(),
        });
        result.logsWritten += 1;

        if (line.event === null) continue;

        const eventRef = this.db.collection(COLLECTIONS.networkEvents).doc();
        batch.set(eventRef, {
          deviceId: line.event.deviceId,
          eventType: line.event.eventType,
          severity: line.event.severity,
          attributes: line.event.attributes,
          source: line.event.source,
          sourceLogId: logRef.id,
          // The device's own timestamp, not the collector's: when the event
          // happened matters more than when we got around to reading it.
          occurredAt: Timestamp.fromDate(line.event.occurredAt),
          recordedAt: FieldValue.serverTimestamp(),
        });
        result.eventsWritten += 1;
      }

      await batch.commit();
    }

    this.logger.debug(
      `Wrote ${result.logsWritten} networkLog(s) and ${result.eventsWritten} networkEvent(s)`,
    );
    return result;
  }
}
