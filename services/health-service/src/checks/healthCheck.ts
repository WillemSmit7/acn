import type { Device, HealthCheckResult } from '../models/types.js';
import { ping, type PingOptions } from './ping.js';

/**
 * Run the reachability check for a single device.
 *
 * Never throws: an unexpected failure is reported as a "down" result carrying
 * the reason, so one broken device can never stop the check round.
 */
export async function checkDevice(
  device: Device,
  options: PingOptions,
): Promise<HealthCheckResult> {
  try {
    const result = await ping(device.checkAddress, options);

    return {
      deviceId: device.id,
      checkType: 'icmp',
      status: result.reachable ? 'healthy' : 'down',
      latencyMs: result.reachable ? result.latencyMs : null,
      target: device.checkAddress,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      deviceId: device.id,
      checkType: 'icmp',
      status: 'down',
      latencyMs: null,
      target: device.checkAddress,
      error: `unexpected check error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Check every device concurrently. Always resolves with one result per device. */
export function checkAll(
  devices: Device[],
  options: PingOptions,
): Promise<HealthCheckResult[]> {
  return Promise.all(devices.map((device) => checkDevice(device, options)));
}
