# ACN Firestore Data Model

The database separates raw observations, normalized events, incidents, and AI
activity. Increment 1 implements only the first three collections; the rest are
documented here so the shape is stable when their increment arrives.

| Collection       | Status        | Written by       |
|------------------|---------------|------------------|
| `devices`        | Increment 1   | Health Service   |
| `healthChecks`   | Increment 1   | Health Service   |
| `networkEvents`  | Increment 1   | Health Service, later Layer 0 |
| `networkLogs`    | Increment 2   | Log Collector    |
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

## `networkEvents/` — implemented (device transitions only)

Normalized events. Increment 1 emits only the two device-level transitions;
Layer 0 adds log-derived types such as `interface_down` in Increment 2.

```json
{
  "deviceId": "r3",
  "eventType": "device_unreachable",
  "severity": "critical",
  "attributes": { "previousStatus": "healthy", "checkType": "icmp" },
  "source": "health-service",
  "occurredAt": "<server timestamp>"
}
```

| `eventType`           | `severity` | Emitted when            |
|-----------------------|------------|-------------------------|
| `device_unreachable`  | `critical` | healthy -> down         |
| `device_recovered`    | `info`     | down -> healthy         |

Events are emitted only on a **change**. A device that is down on the very
first observation seeds a baseline and produces no event, so restarting the
service never spams phantom events. `attributes` is deliberately open so
Layer 0 can extend it without a schema migration.

`source` records which component produced the event — from Increment 2 this
distinguishes Health Service transitions from Layer 0 normalizations.

Increment 2 adds `sourceLogId`, linking a normalized event back to the raw
`networkLogs` document it came from, so the original text is always traceable.

---

## Planned collections

### `networkLogs/` — Increment 2

```json
{
  "deviceId": "r2",
  "source": "syslog",
  "raw": "%LINK-3-UPDOWN: Interface eth2 changed state to down",
  "receivedAt": "<server timestamp>"
}
```

### `incidents/` — Increment 3

```json
{
  "incidentId": "INC-001",
  "status": "resolved",
  "startedAt": "...",
  "resolvedAt": "...",
  "symptoms": ["r3 unreachable", "pc2 unreachable"],
  "probableRootCause": "r2-r3 link failure"
}
```

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
later increments need: health checks by device over time, and events by device
or by type over time.

## Security rules

`firebase/firestore.rules` denies all direct client access. Every write comes
from a backend service using the Admin SDK, which bypasses rules. This opens
up deliberately in Increment 7 when the Angular UI and Firebase Auth arrive.
