import type { LogSource } from '../models/types.js';

/** A device whose logs Layer 0 collects. */
export interface LogSourceConfig {
  /** Must match the device id used in devices/ by the Health Service. */
  deviceId: string;
  containerName: string;
  /**
   * Paths of the log files inside the container. FRR writes one file per
   * daemon: zebra carries interface state and ospfd carries adjacency changes,
   * and both are needed to see a link failure completely.
   *
   * These paths are set by the --log startup flags in lab/configs/daemons, not
   * by frr.conf - ospfd rejects a runtime `log file` command.
   */
  logPaths: string[];
  source: LogSource;
}

const FRR_LOG_PATHS = [
  '/var/log/frr/zebra.log',
  '/var/log/frr/ospfd.log',
  '/var/log/frr/acn-monitor.log',
];

/**
 * The log sources Layer 0 tails.
 *
 * Only the routers appear here: pc1 and pc2 are plain Linux hosts running no
 * routing daemon, so they have no FRR log to read. They are still monitored by
 * the Health Service over ICMP - a device can be observable without being a
 * log source, and Increment 3 correlates across both.
 *
 * deviceId matches devices/ deliberately, so a networkEvent from Layer 0 and
 * one from the Health Service join on the same key.
 */
export const logSources: LogSourceConfig[] = ['r1', 'r2', 'r3'].map((deviceId) => ({
  deviceId,
  containerName: `clab-acn-${deviceId}`,
  logPaths: FRR_LOG_PATHS,
  source: 'frr' as const,
}));
