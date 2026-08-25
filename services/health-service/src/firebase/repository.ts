import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type {
  Device,
  HealthCheckResult,
  NetworkEvent,
} from '../models/types.js';
import type { Logger } from '../logger.js';

export const COLLECTIONS = {
  devices: 'devices',
  healthChecks: 'healthChecks',
  networkEvents: 'networkEvents',
} as const;

/**
 * All Firestore access for the Health Service.
 *
 * Every write is best-effort and logged on failure: losing the database must
 * never stop the service from observing the network (security rule 8).
 */
export class AcnRepository {
  constructor(
    private readonly db: Firestore,
    private readonly logger: Logger,
  ) {}

  /**
   * Upsert the configured devices into devices/.
   *
   * Uses merge so operator-managed fields added later are not clobbered by a
   * restart of the service.
   */
  async syncDevices(devices: Device[]): Promise<void> {
    const batch = this.db.batch();

    for (const device of devices) {
      const ref = this.db.collection(COLLECTIONS.devices).doc(device.id);
      batch.set(
        ref,
        {
          id: device.id,
          name: device.name,
          type: device.type,
          managementAddress: device.managementAddress,
          checkAddress: device.checkAddress,
          enabled: device.enabled,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    await batch.commit();
    this.logger.info(`Synced ${devices.length} device record(s) to Firestore`);
  }

  /** Persist one round of health checks. Returns the number written. */
  async saveHealthChecks(results: HealthCheckResult[]): Promise<number> {
    if (results.length === 0) return 0;

    const batch = this.db.batch();
    for (const result of results) {
      const ref = this.db.collection(COLLECTIONS.healthChecks).doc();
      batch.set(ref, {
        deviceId: result.deviceId,
        checkType: result.checkType,
        status: result.status,
        latencyMs: result.latencyMs,
        target: result.target,
        error: result.error ?? null,
        checkedAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    return results.length;
  }

  /** Persist normalized network events. Returns the number written. */
  async saveNetworkEvents(events: NetworkEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    const batch = this.db.batch();
    for (const event of events) {
      const ref = this.db.collection(COLLECTIONS.networkEvents).doc();
      batch.set(ref, {
        deviceId: event.deviceId,
        eventType: event.eventType,
        severity: event.severity,
        attributes: event.attributes,
        source: event.source,
        occurredAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    return events.length;
  }
}
