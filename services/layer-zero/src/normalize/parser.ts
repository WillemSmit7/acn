import type { ParsedLogLine } from '../models/types.js';

/**
 * Structural parser for FRRouting log lines.
 *
 * This stage only splits the envelope from the message; it assigns no meaning.
 * Deciding what a message *is* belongs to rules.ts, so an unrecognised message
 * still yields a well-formed record instead of being discarded.
 *
 * Real lines from the lab (FRR 10.2.1):
 *
 *   2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)
 *   2026/08/25 19:13:33 OSPF: [Y05P2-YJVXY] AdjChg: Nbr 10.255.0.3, ... Full -> Deleted (KillNbr)
 *   2026/08/25 18:45:41 ZEBRA: [NNACN-54BDA][EC 4043309110] Disabling MPLS support
 *
 * Not every line has this shape. FRR's startup also emits unstructured noise
 * such as "[33|zebra] sending configuration" and "Waiting for children...",
 * which returns null here and is stored as an unparsed raw log.
 */
const FRR_LINE =
  /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? ([A-Z0-9]+): \[([0-9A-Z]{5}-[0-9A-Z]{5})\](?:\[EC (\d+)\])? (.*)$/;

/**
 * Parse one FRR log line, or return null if it is not in FRR's structured
 * format. Never throws: a malformed line is a normal occurrence, not an error.
 */
export function parseFrrLine(line: string): ParsedLogLine | null {
  const match = FRR_LINE.exec(line.trim());
  if (match === null) return null;

  const [, year, month, day, hour, minute, second, fraction, daemon, code, errorCode, message] =
    match;

  // Every group above except `fraction`, `errorCode` and `message` is
  // non-optional in the pattern, but noUncheckedIndexedAccess cannot know
  // that, so the guard is required rather than decorative.
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    daemon === undefined ||
    code === undefined ||
    message === undefined
  ) {
    return null;
  }

  const loggedAt = toUtcDate(year, month, day, hour, minute, second, fraction);
  if (loggedAt === null) return null;

  return {
    loggedAt,
    daemon,
    code,
    errorCode: errorCode === undefined ? null : Number.parseInt(errorCode, 10),
    message,
  };
}

/**
 * FRR stamps its log lines with the container's local time and no offset. The
 * lab containers run UTC (verified against the host), so the components are
 * assembled with Date.UTC rather than the Date string constructor - the latter
 * would silently reinterpret them in the collector's own timezone and shift
 * every event by the host's offset.
 */
function toUtcDate(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
  fraction: string | undefined,
): Date | null {
  const millis =
    fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);

  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millis,
  );

  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}
