# ACN Firestore Data Model

The database separates raw observations, normalized events, incidents, and AI
activity. Increments 1 to 3 implement the first five collections; the rest are
documented here so the shape is stable when their increment arrives.

| Collection       | Status        | Written by       |
|------------------|---------------|------------------|
| `devices`        | Increment 1   | Health Service   |
| `healthChecks`   | Increment 1   | Health Service   |
| `networkEvents`  | Increment 1-2 | Health Service, Layer 0 |
| `networkLogs`    | Increment 2   | Layer 0          |
| `incidents`      | Increment 3   | Incident Service |
| `agentRuns`      | Increment 4   | Agent Service    |
| `agentActions`   | Increment 5   | Agent Service    |
| `networkChanges` | Increment 5   | Network Controller |

---

## `devices/` — implemented

Document id is the device id. Upserted with `merge: true` on every service
start, so operator-managed fields added later survive a restart.

```json
{
  "id": "r2",
  "name": "Router 2",
  "type": "router",
  "managementAddress": "172.20.20.12",
  "checkAddress": "10.255.0.2",
  "enabled": true,
  "updatedAt": "<server timestamp>"
}
```

`type` is `router` or `host`. See `docs/architecture.md` for why
`checkAddress` and `managementAddress` are different addresses.

## `healthChecks/` — implemented

One document per device per check round. Auto-generated document id.

```json
{
  "deviceId": "r3",
  "checkType": "icmp",
  "status": "down",
  "latencyMs": null,
  "target": "10.255.0.3",
  "error": "no reply within timeout",
  "checkedAt": "<server timestamp>"
}
```

`status` is `healthy` or `down`. `latencyMs` is the lowest observed round-trip
time, or `null` when nothing replied. `error` is `null` on success. This is a
high-volume append-only collection — Increment 10 revisits its storage if
volume demands it.

## `networkLogs/` — implemented

Every log line collected from a device, stored verbatim. Auto-generated
document id. Written by Layer 0.

```json
{
  "deviceId": "r2",
  "source": "frr",
  "raw": "2026/08/25 19:37:27 OSPF: [Y05P2-YJVXY] AdjChg: Nbr 10.255.0.3, NbrIP 10.0.23.2 (default) on eth2:10.0.23.1: Full -> Deleted (KillNbr)",
  "daemon": "OSPF",
  "code": "Y05P2-YJVXY",
  "errorCode": null,
  "message": "AdjChg: Nbr 10.255.0.3, ... Full -> Deleted (KillNbr)",
  "parsed": true,
  "normalized": true,
  "loggedAt": "<device timestamp>",
  "receivedAt": "<server timestamp>"
}
```

`raw` is the untouched original and is always present. The structured fields
(`daemon`, `code`, `errorCode`, `message`, `loggedAt`) are null when the line
did not match FRR's structured format — FRR emits unstructured startup noise
such as `[33|zebra] sending configuration`. Storing those anyway keeps parser
gaps visible and recoverable instead of silently discarding what the device
actually said.

`parsed` records whether the envelope was understood; `normalized` whether a
rule turned it into an event. The two differ: most parsed lines are routine
bookkeeping that produces no event.

`loggedAt` is the device's own timestamp, `receivedAt` is when the collector
wrote it. Both are kept because they answer different questions — when it
happened, and when we found out.

This is an append-only high-volume collection, like `healthChecks/`;
Increment 10 revisits retention.

## `networkEvents/` — implemented

Normalized events, written by two producers. The Health Service emits
device-level transitions from ICMP; Layer 0 emits log-derived types. Both land
here so Increment 3 can correlate across them, and `source` tells them apart.

```json
{
  "deviceId": "r2",
  "eventType": "ospf_neighbor_down",
  "severity": "warning",
  "attributes": {
    "neighborId": "10.255.0.3",
    "neighborIp": "10.0.23.2",
    "interface": "eth2",
    "localIp": "10.0.23.1",
    "vrf": "default",
    "fromState": "Full",
    "toState": "Deleted",
    "reason": "KillNbr"
  },
  "source": "layer-zero",
  "sourceLogId": "<networkLogs document id>",
  "occurredAt": "<device timestamp>",
  "recordedAt": "<server timestamp>"
}
```

| `eventType`           | `severity` | `source`         | Emitted when                    |
|-----------------------|------------|------------------|---------------------------------|
| `device_unreachable`  | `critical` | `health-service` | healthy -> down (ICMP)          |
| `device_recovered`    | `info`     | `health-service` | down -> healthy (ICMP)          |
| `interface_down`      | `warning`  | `layer-zero`     | zebra reports an interface down |
| `interface_up`        | `info`     | `layer-zero`     | zebra reports an interface up   |
| `ospf_neighbor_down`  | `warning`  | `layer-zero`     | OSPF adjacency leaves Full      |
| `ospf_neighbor_up`    | `info`     | `layer-zero`     | OSPF adjacency reaches Full     |

`sourceLogId` links a normalized event back to the exact `networkLogs`
document it was derived from, so the original text behind any event is one
lookup away. Health Service events set it to `null` — an ICMP probe has no
originating log line — rather than omitting it, so every document has the same
shape and consumers never special-case its absence.

The raw log and the event derived from it are written in the same batch, with
the log's id generated locally beforehand. `networkEvents` therefore never
contains an event pointing at a `networkLogs` document that does not exist.

Health Service events are emitted only on a **change**. A device that is down
on the very first observation seeds a baseline and produces no event, so
restarting the service never spams phantom events. Layer 0 events are
inherently edge-triggered: the device only logs a transition when one happens.

`attributes` is deliberately open, and its contents are event-type specific.

## `incidents/` — implemented

One incident per correlated fault. **The document id is the `incidentId`**, so
an incident is updated in place as it develops rather than appended to: the UI
and Increment 4's agent both want the current state of INC-001, not a history of
partial guesses about it.

```json
{
  "incidentId": "INC-001",
  "status": "resolved",
  "severity": "critical",
  "startedAt": "<first event>",
  "lastEventAt": "<most recent event>",
  "resolvedAt": "<when the symptoms cleared>",
  "affectedDevices": ["pc2", "r2", "r3"],
  "unreachableDevices": [],
  "symptoms": ["pc2 unreachable", "r2 eth2 down", "r3 unreachable"],
  "rootCauseType": "link_failure",
  "probableRootCause": "R2 <-> R3 link failure",
  "rootCause": {
    "type": "link_failure",
    "devices": ["r2", "r3"],
    "summary": "R2 <-> R3 link failure",
    "confidence": "confirmed",
    "evidence": [
      "r2 reported eth2 down",
      "r2 lost OSPF adjacency with r3",
      "r3 lost OSPF adjacency with r2",
      "r3 reported eth1 down",
      "both ends reported independently, so both devices are alive - the link between them is not"
    ],
    "predictedUnreachable": ["pc2", "r3"],
    "observedUnreachable": ["pc2", "r3"],
    "predictionMatches": true
  },
  "eventIds": ["<networkEvents ids>"],
  "eventCount": 13,
  "updatedAt": "<server timestamp>"
}
```

`rootCauseType` is `link_failure`, `device_failure`, `unknown` or `analyzing`.
`confidence` is `confirmed` when both ends of a link independently reported
losing each other, and `probable` when one end reported and the silent peer is
itself unreachable — consistent with that peer having failed, but the peer
cannot corroborate because it is gone.

`predictedUnreachable` is derived by removing the failed link or device from the
topology and asking what is still reachable from r1. Storing it next to
`observedUnreachable` makes each diagnosis check itself; a mismatch is recorded
rather than hidden.

`unreachableDevices` is live state — devices still down right now — where
`observedUnreachable` inside `rootCause` is frozen at the moment the diagnosis
was made. They differ during recovery, on purpose.

`eventIds` completes the traceability chain: incident -> networkEvents ->
networkLogs, so any conclusion can be followed to the raw text a device emitted.

See `docs/incident-model.md` for the correlation and lifecycle rules.

---

## Planned collections

### `agentActions/` — Increment 5

```json
{
  "incidentId": "INC-001",
  "agentRunId": "RUN-001",
  "deviceId": "r2",
  "action": "enable_interface",
  "parameters": { "interface": "eth2" },
  "riskLevel": "medium",
  "approvalRequired": true,
  "approvedBy": null,
  "status": "proposed",
  "createdAt": "..."
}
```

### `networkChanges/` — Increment 5

```json
{
  "incidentId": "INC-001",
  "deviceId": "r2",
  "action": "enable_interface",
  "performedBy": "claude-agent",
  "beforeState": { "interface": "eth2", "status": "down" },
  "afterState":  { "interface": "eth2", "status": "up" },
  "successful": true,
  "rollbackAvailable": true,
  "createdAt": "..."
}
```

These historical collections must eventually let the agent answer: have we
seen these symptoms before, what was the cause, what fixed it, did it work,
and was it later rolled back.

## Indexes

`firebase/firestore.indexes.json` defines composite indexes for the queries
later increments need: health checks by device over time, events by device, by
type or by producer over time, raw logs by device over time, and incidents by
status over time.

## Security rules

`firebase/firestore.rules` denies **all client writes**. Every write comes from
a backend service using the Admin SDK, which bypasses rules.

Client *reads* are open for the five collections the Increment 3 dashboard
renders (`devices`, `healthChecks`, `networkLogs`, `networkEvents`,
`incidents`). Collections belonging to later increments stay closed.

That is safe only because the dashboard runs against a local emulator holding
synthetic lab data, with no Firebase Auth yet. **This ruleset must not be
deployed to a real project as it stands** — Increment 7 replaces
`allow read: if true` with per-user authorisation.
