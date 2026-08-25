# ACN — AI-Centered Network

A testable network-operations environment where network data is collected,
normalized, stored and — in later increments — reasoned about and acted on by
an AI agent.

**Current status: Increment 1 complete.** See [PROGRESS.md](PROGRESS.md).

Increment 1 is the first complete vertical slice:

```
emulated network  ->  Health Service  ->  Firestore
```

The system runs an emulated network, periodically checks device reachability,
persists every check, detects healthy <-> down transitions, and records those
transitions as network events. Nothing above that layer exists yet — no AI, no
UI, no incident correlation.

---

## Prerequisites

- Ubuntu (developed on 24.04 / 26.04)
- Node.js 20+ and npm
- Java 11+ (required by the Firestore emulator)
- Firebase CLI: `npm install -g firebase-tools`
- Docker Engine and Containerlab — install with:

```bash
./lab/install-prereqs.sh     # needs sudo; log out and back in afterwards
```

Docker group membership does **not** apply to the shell you ran the installer
from. Activate it without logging out:

```bash
newgrp docker
```

Check it worked with `id` — you should see `docker` in the group list. Every
lab script verifies Docker access up front and tells you this if it is missing.

---

## Setup

```bash
git clone <this-repo> acn && cd acn
npm install
cp services/health-service/.env.example services/health-service/.env
```

The default `.env` points at the local Firestore emulator. No credentials are
needed and none are stored in the repo.

---

## Running

Five terminals. Increments 1-3 plus the dashboard.

**Terminal 1 — the emulated network**

```bash
./lab/deploy.sh          # deploys the topology and adds host routes (uses sudo)
./lab/verify.sh          # proves PC1 <-> PC2 and all loopbacks are reachable
```

**Terminal 2 — Firestore**

```bash
npm run emulators        # Firestore on 127.0.0.1:8080, UI on http://127.0.0.1:4000
```

**Terminal 3 — the Health Service**

```bash
npm run health-service
```

**Terminal 4 — Layer 0** (Increment 2)

```bash
npm run layer-zero
```

Layer 0 tails each router's FRR logs, stores every line in `networkLogs/`, and
writes normalized `networkEvents/` for interface and OSPF adjacency changes.

**Terminal 5 — the Incident Service** (Increment 3)

```bash
npm run incident-service
```

Correlates the event stream into `incidents/` with a probable root cause.

**The NOC dashboard** (read-only live view of all of the above)

```bash
npm run web              # http://localhost:4200
```

No real Firebase project is needed: the browser app talks to the Firestore
emulator with the ordinary Firebase SDK, live `onSnapshot` listeners and all.

---

## Demonstration

With all three running:

```
[16:20:00] ACN Health Service starting
[16:20:00] Firestore: emulator at 127.0.0.1:8080 (project acn-local)
[16:20:00] Synced 5 device record(s) to Firestore
[16:20:00] Monitoring 5 device(s) every 30s
[16:20:00] r1   healthy 1.8ms
[16:20:00] r2   healthy 2.1ms
[16:20:00] r3   healthy 1.4ms
[16:20:00] pc1  healthy 1.9ms
[16:20:00] pc2  healthy 2.4ms
```

Break the R2 <-> R3 link:

```bash
./lab/scenarios/01-link-failure.sh
```

```
[16:20:30] r1   healthy 1.7ms
[16:20:30] r2   healthy 2.0ms
[16:20:30] r3   DOWN    no reply within timeout
[16:20:30] pc1  healthy 1.9ms
[16:20:30] pc2  DOWN    no reply within timeout
[16:20:30] EVENT DEVICE_UNREACHABLE device=r3 severity=critical
[16:20:30] EVENT DEVICE_UNREACHABLE device=pc2 severity=critical
[16:20:30] Wrote 2 networkEvent document(s)
```

In the emulator UI, `networkEvents/` now contains:

```json
{ "deviceId": "r3", "eventType": "device_unreachable", "severity": "critical" }
```

Restore the network:

```bash
./lab/scenarios/03-restore-network.sh
```

```
[16:21:00] r3   healthy 1.5ms
[16:21:00] pc2  healthy 2.3ms
[16:21:00] EVENT DEVICE_RECOVERED device=r3 severity=info
[16:21:00] EVENT DEVICE_RECOVERED device=pc2 severity=info
```

```json
{ "deviceId": "r3", "eventType": "device_recovered", "severity": "info" }
```

### Automated end-to-end test

With the lab and emulator running, this drives the whole cycle and asserts the
Firestore contents:

```bash
./scripts/e2e-test.sh
```

It clears the emulator, restores the lab, starts the service on a 5-second
interval, breaks the link, restores it, then verifies that `healthChecks/`
recorded both healthy and down results and that `r3` produced
`device_unreachable` followed by `device_recovered`.

For Increment 2, this runs the Health Service and Layer 0 together over the same
cycle and asserts the log pipeline:

```bash
./scripts/e2e-layer-zero.sh
```

It checks that raw lines reached `networkLogs/`, that at least three event types
were normalized, that every derived event resolves through its `sourceLogId`
back to the exact line it came from, and that the R2-R3 failure was observed
independently from both routers.

For Increment 3, this runs the whole stack through **both** fault scenarios and
asserts they are told apart:

```bash
./scripts/e2e-incidents.sh
```

Scenario 01 (link cut) and scenario 02 (router stopped) produce an identical set
of `device_unreachable` events, so this is the honest test of whether
correlation is doing anything ICMP alone could not. It asserts one is diagnosed
`link_failure` and the other `device_failure`, that each root cause predicts the
symptoms actually observed, and that every incident traces back through its
events to raw log lines.

---

## The topology

```
PC1 ---- R1 ---- R2 ---- R3 ---- PC2
```

| Link     | Subnet        | Addresses              |
|----------|---------------|------------------------|
| PC1–R1   | 10.0.1.0/30   | PC1 .2, R1 .1          |
| R1–R2    | 10.0.12.0/30  | R1 .1, R2 .2           |
| R2–R3    | 10.0.23.0/30  | R2 .1, R3 .2           |
| R3–PC2   | 10.0.3.0/30   | R3 .1, PC2 .2          |

| Device | Loopback / check address | Management address |
|--------|--------------------------|--------------------|
| r1     | 10.255.0.1               | 172.20.20.11       |
| r2     | 10.255.0.2               | 172.20.20.12       |
| r3     | 10.255.0.3               | 172.20.20.13       |
| pc1    | 10.0.1.2                 | 172.20.20.21       |
| pc2    | 10.0.3.2                 | 172.20.20.22       |

Routers run FRRouting with OSPF in area 0. The Health Service checks the
**loopback** addresses, not the management addresses — management stays up even
when the data plane is broken, so pinging it would make link failures
invisible. `lab/deploy.sh` adds the host routes that make loopbacks reachable
from the Health Service process. See [docs/architecture.md](docs/architecture.md).

---

## Scenarios

| Script | Effect | Recovery |
|--------|--------|----------|
| `lab/scenarios/01-link-failure.sh` | Shuts R2 eth2 (the link to R3) | `03-restore-network.sh` |
| `lab/scenarios/02-router-failure.sh` | Stops the R3 container | `03-restore-network.sh` |
| `lab/scenarios/03-restore-network.sh` | Returns everything to a healthy baseline | — |

All are repeatable and none rebuild the lab.

---

## Configuration

`services/health-service/.env` (see `.env.example`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `FIRESTORE_EMULATOR_HOST` | `127.0.0.1:8080` | Set = use emulator. **Unset = use production Firebase.** |
| `FIREBASE_PROJECT_ID` | `acn-local` | Firebase project id |
| `HEALTH_CHECK_INTERVAL_SECONDS` | `30` | Seconds between check rounds |
| `HEALTH_CHECK_TIMEOUT_SECONDS` | `2` | Per-reply ICMP timeout |
| `HEALTH_CHECK_PING_COUNT` | `2` | Echo requests per check |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

Devices are configured in
[`services/health-service/src/config/devices.ts`](services/health-service/src/config/devices.ts)
— the single source of truth for lab addressing.

No credentials are committed. Against the emulator no credential is used at
all; against real Firebase the service uses Application Default Credentials.

---

## Development

```bash
npm test                 # unit tests
npm run build            # compile TypeScript
npm run lab:deploy       # same as ./lab/deploy.sh
npm run lab:break        # break the R2-R3 link
npm run lab:restore      # restore the network
./scripts/reset-firestore.sh   # wipe emulator data
./lab/destroy.sh         # tear the lab down and remove host routes
```

---

## Repository layout

```
acn/
├── lab/                     containerlab topology, FRR configs, fault scenarios
├── services/
│   ├── health-service/      Increment 1 — ICMP checks -> Firestore
│   ├── layer-zero/          Increment 2 — FRR logs -> networkLogs + networkEvents
│   ├── incident-service/    Increment 3 — networkEvents -> incidents
│   ├── agent-service/       Increment 4 (placeholder)
│   └── network-controller/  Increment 5 (placeholder)
├── apps/web/                Angular NOC dashboard — read-only live view
├── firebase/                Firestore rules and indexes
├── scripts/                 end-to-end test and helpers
└── docs/                    architecture, data model, incident model
```

---

## Documentation

- [PROGRESS.md](PROGRESS.md) — what is done, what is next
- [docs/architecture.md](docs/architecture.md) — layering and key design decisions
- [docs/data-model.md](docs/data-model.md) — Firestore collections
- [docs/incident-model.md](docs/incident-model.md) — correlation and root-cause rules
