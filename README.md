# ACN — AI-Centered Network

A testable network-operations environment where network data is collected,
normalized and stored, investigated by an AI agent, and repaired only through
a guarded controller after human approval.

**Current status: Increments 1–5 complete; Increment 6 guarded remediation is implemented and awaiting live-lab acceptance.**
See [PROGRESS.md](PROGRESS.md).

The current end-to-end path is:

```
network -> health/log collection -> normalized events -> incidents
        -> GPT investigation -> validated proposal -> human approval
        -> fixed repair -> autonomous verification -> live NOC dashboard
```

GPT has no command or network capability. It emits one typed proposal as inert
data. The localhost Network Controller validates the completed run and
citations, a named human approves, and only a code-owned adapter can run. Each
of the five mutating adapters has one fixed lab target; success requires fresh
autonomous recovery evidence and a resolved incident. Live-lab acceptance for
guarded remediation is still pending; see [PROGRESS.md](PROGRESS.md).

---

## Prerequisites

- Ubuntu (developed on 24.04 / 26.04)
- Node.js 20+ and npm
- Java 11+ (required by the Firestore emulator)
- Firebase CLI: `npm install -g firebase-tools`
- Docker Engine and Containerlab — install with:

```bash
./lab/install-prereqs.sh     # needs sudo; start a fresh login session afterwards
```

Docker group membership does **not** apply to the shell or processes that were
already running when the installer added it. Start a fresh login session
(close and reopen the terminal, or restart VS Code if it launched the terminal).
On the documented host, `newgrp` and `sg` are unavailable, so do not use them
to refresh membership. Verify both `id -nG "$USER"` and `id -nG` include
`docker` before running lab commands. The lab scripts detect stale membership
and report it explicitly.

---

## Setup

```bash
git clone <this-repo> acn && cd acn
npm install
cp services/health-service/.env.example services/health-service/.env
cp services/agent-service/.env.example services/agent-service/.env
# Put your OPENAI_API_KEY in the agent-service .env file.
```

The default `.env` points at the local Firestore emulator. No credentials are
needed and none are stored in the repo.

---

## Running

### One-command operator stack

Once `OPENAI_API_KEY` is exported or saved in the gitignored
`services/agent-service/.env`, run:

```bash
npm run start:all
```

This builds the project, verifies the lab and deploys a healthy baseline when
needed, then starts Firestore, all telemetry/correlation/investigation services,
the local Lab Controller, guarded Network Controller and Angular visualizer. It selects the first free
dashboard port from 4200 upward, opens it when a desktop session is available,
and prints every endpoint and log path.

Keep that terminal open. Press **Ctrl+C** to stop every process the launcher
started. Per-process logs remain under `.acn-runtime/logs/`.

The first run after a reboot may ask for sudo only when `lab/deploy.sh` needs to
restore the two host routes. Useful optional modes are listed by:

```bash
npm run start:all -- --help
```

In particular, `ACN_SKIP_AGENT=1 npm run start:all` starts the complete free
stack without Luna.

### Individual processes

Run the lab, emulator, four telemetry/investigation services and the local lab
controller in separate terminals; the dashboard is another process.

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

Layer 0 tails each router's FRR logs and independently polls intended router
state. It stores exact log/probe evidence in `networkLogs/` and writes normalized
`networkEvents/` for interface, OSPF, configuration, service, and resource-state
changes. Fault scenarios do not write monitoring events.

**Terminal 5 — the Incident Service** (Increment 3)

```bash
npm run incident-service
```

Correlates the event stream into `incidents/` with a probable root cause.

**Terminal 6 — the Agent Service** (Increment 4)

```bash
npm run agent-service
```

Reads each settled incident and its raw evidence, asks `gpt-5.6-luna` for an
independent structured diagnosis, and writes the run to `agentRuns/`. For
controlled lab runs, it also claims an opaque hidden-evaluation record and
scores the returned diagnosis and repair proposal only after citation
validation. The proposal is inert: this service never remediates or changes the
network.

**Terminal 7 — local lab controller**

```bash
npm run lab-controller   # localhost-only API on 127.0.0.1:8787
```

This powers five whitelisted fault buttons plus restore. It is a manual
synthetic-lab harness, completely separate from GPT remediation.

**Terminal 8 — guarded Network Controller**

```bash
npm run network-controller   # approval API on 127.0.0.1:8788
```

It watches completed runs, persists validated proposals, and exposes exact
approve/reject routes. Every adapter uses reviewed, fixed `docker` argument
arrays with no shell and no model- or request-controlled target or argument.

**The NOC dashboard** (live view and manual demo controls)

```bash
npm run web              # http://localhost:4200
```

No real Firebase project is needed: the browser app talks to the Firestore
emulator with the ordinary Firebase SDK, live `onSnapshot` listeners and all.
The browser still has no Firestore write permission and cannot execute an
arbitrary command. Buttons call only the localhost controller's named routes.
The repair card calls the separate Network Controller; an approval request
carries only the action id and operator identity.

---

## Demonstration

With the telemetry stack running:

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

Administratively disable the R2 logical port toward R3:

```bash
./lab/scenarios/03-interface-disabled.sh
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
./lab/scenarios/06-restore-network.sh
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
cycle and asserts the log collection and normalization flow:

```bash
./scripts/e2e-layer-zero.sh
```

It checks that raw lines reached `networkLogs/`, that at least three event types
were normalized, that every derived event resolves through its `sourceLogId`
back to the exact line it came from, and that the R2-R3 failure was observed
independently from both routers.

This runs the live stack through all five ISP-style fault scenarios:

```bash
./scripts/e2e-incidents.sh
```

For fast, deterministic verification with no model charge, run
`npm run test:e2e:failure-categories`. It exercises autonomous state snapshots
through transition detection, neutral prompt projection and post-response
ground-truth scoring.

For live guarded repair acceptance across all five fault scenarios, with the
lab and emulator running:

```bash
npm run test:e2e:guarded-remediation
```

This injects the interface-disabled scenario, creates a deterministic validated
completed-run fixture (no paid model call), approves it through the same API as
the dashboard, and asserts the action, audit trail, network change, fresh
observer recovery and resolved incident. The script is provided without a
claim that it has been run successfully on a live lab in this change.

With the Firestore emulator running, the lab-only truth boundary itself is
verified without a model call:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run test:e2e:evaluation-boundary
```

For live GPT investigation, this creates incidents from real lab scenarios and
has GPT-5.6 Luna investigate them:

```bash
OPENAI_API_KEY=... ./scripts/e2e-agent.sh
```

It verifies that each run cites real events and raw logs, receives no
deterministic diagnosis or cause-revealing event label, distinguishes the fault
scenarios, and records model, prompt, tokens, latency and cost. Runs started by
direct scenario scripts are intentionally unscored; controller-triggered lab
runs receive hidden ground truth after GPT responds.

For an interactive demonstration, keep all services running, open the NOC
dashboard and use **Manual fault controls**. The **Live operations timeline**
merges health checks, raw FRR lines, normalized events, incident correlation,
controller output and Luna's current/final comment in timestamp order.

### Diagnosis confidence and incident PDFs

The investigation panel shows the suspected cause, qualitative confidence
(high, medium or low), reasoning and supporting evidence. Confidence is the
model's assessment of the supplied evidence, not a verified probability.
Expand cited events and logs to inspect their IDs, UTC timestamps, sources,
metric attributes and original output. Evidence is fetched by document ID,
including records outside the dashboard's recent window. Missing records or
read failures are shown explicitly. Hidden lab scoring remains an internal
test mechanism and is not presented as diagnosis confidence.

Once the latest investigation finishes successfully, expand its incident and
select **Download incident PDF** to export a report with
a plain-language summary, diagnosis and confidence, timeline, measured elapsed
times, approval/rejection history, action status and cited evidence. The summary
reuses the completed investigation's generated summary; export makes no new
model call. New investigations use the manager-friendly summary prompt, while
older investigations retain their original text. Download is disabled when
there is no completed summary or a newer investigation is pending or failed;
the export service also checks eligibility before generating a PDF. Reports
use a styled cover header, timing cards, a readable timeline and a separate
evidence appendix.

PDFs use a fresh read of the incident and related records, with explicit notices
for missing evidence or history limits. All timestamps are UTC. Unavailable
timings are marked rather than estimated; unresolved cases are not reported as
recovered. Operator names are recorded values, not authenticated identities.
The renderer and embedded fonts load locally; incident data is not sent to a
PDF service. Run `npm run test:incident-report` for report and pagination checks.

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
| `lab/scenarios/01-configuration-drift.sh` | Changes the intended OSPF interface cost | `06-restore-network.sh` |
| `lab/scenarios/02-routing-session-failure.sh` | Makes an OSPF interface passive while its port stays up | `06-restore-network.sh` |
| `lab/scenarios/03-interface-disabled.sh` | Administratively disables R2 eth2 | `06-restore-network.sh` |
| `lab/scenarios/04-routing-service-crash.sh` | Stops R3 ospfd while the router remains alive | `06-restore-network.sh` |
| `lab/scenarios/05-resource-exhaustion.sh` | Applies bounded CPU pressure that starves ospfd | `06-restore-network.sh` |
| `lab/scenarios/06-restore-network.sh` | Returns every scenario to the intended baseline | — |

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
`OPENAI_API_KEY` is server-side only and belongs in the gitignored
`services/agent-service/.env`, never in `apps/web`.

---

## Development

```bash
npm run start:all        # complete interactive operator stack
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
│   ├── agent-service/       Increments 4-5 — GPT diagnosis/evaluation + inert repair proposals
│   ├── lab-controller/      Local manual demo controls -> labActions
│   └── network-controller/  Increment 6 — guarded proposals, approval and fixed repair
├── apps/web/                Angular NOC dashboard — live telemetry/investigation + lab controls
├── firebase/                Firestore rules and indexes
├── scripts/                 end-to-end test and helpers
└── docs/                    architecture, data models, developer and increment guides
```

---

## Documentation

- [PROGRESS.md](PROGRESS.md) — what is done, what is next
- [docs/developer-manual.md](docs/developer-manual.md) — contributor workflow, change locations, tests, and troubleshooting
- [docs/architecture.md](docs/architecture.md) — layering and key design decisions
- [docs/data-pipeline.md](docs/data-pipeline.md) — ACN's telemetry and investigation
  data pipeline, from source to serving
- [docs/FunctionDiagrams.md](docs/FunctionDiagrams.md) — component responsibilities and diagrams of implemented and planned system flows
- [docs/increment-5-plan.md](docs/increment-5-plan.md) — evidence-first GPT evaluation boundary
- [docs/increment-6-plan.md](docs/increment-6-plan.md) — guarded remediation design and safety boundary
- [docs/data-model.md](docs/data-model.md) — Firestore collections
- [docs/incident-model.md](docs/incident-model.md) — correlation and root-cause rules
