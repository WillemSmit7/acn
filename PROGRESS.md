# ACN Progress

Last updated: 2026-08-25

| Increment | Scope | Status |
|-----------|-------|--------|
| **1** | Emulated network + Health Service + Firestore | **Code complete — lab run pending** |
| 2 | Raw logs + Layer 0 normalization | Not started |
| 3 | Incident detection and correlation | Not started |
| 4 | Claude read-only investigation agent | Not started |
| 5 | Controlled network actions | Not started |
| 6 | Risk levels and approval workflow | Not started |
| 7 | Angular NOC UI | Not started |
| 8 | Historical intelligence | Not started |
| 9 | Advanced monitoring (SNMP, gNMI, BGP/OSPF) | Not started |
| 10 | Production storage and scalability | Not started |

---

## Increment 1 — status

Everything is written and the software half is verified. The one thing not yet
executed on this machine is the containerlab half, because Docker and
Containerlab are not installed and installing them needs an interactive sudo
password. Run `./lab/install-prereqs.sh`, then `./scripts/e2e-test.sh`.

### Verified on this machine

- **18/18 unit tests pass** (`npm test`) — ping output parsing, ping exit-code
  classification, real ICMP against a reachable and an unroutable address, and
  the full state-transition matrix.
- **TypeScript compiles clean** under `strict` + `noUncheckedIndexedAccess`
  (`npm run build`).
- **Firestore write path verified against the real emulator.** The actual
  `HealthService` was driven through a healthy → down → healthy cycle using a
  controllable target set. Result:

  ```
  devices/       : 2 docs
  healthChecks/  : 6 docs   (healthy, healthy, healthy, down, healthy, healthy)
  networkEvents/ : 2 docs
     r3 device_unreachable severity=critical  attrs={"previousStatus":"healthy"}
     r3 device_recovered   severity=info      attrs={"previousStatus":"down"}
  ```

  Server timestamps were set on every document, and exactly two events were
  emitted — no phantom event on the baseline round.
- **`scripts/assert-firestore.mjs` verified both ways** — it passes on correctly
  seeded data and fails on an empty database, so the assertions are not
  vacuous.
- **`scripts/reset-firestore.sh` verified** against the running emulator.

### Not yet executed

- `./lab/deploy.sh` — needs Docker + Containerlab
- `./lab/verify.sh` — PC1 ↔ PC2 connectivity
- `./lab/scenarios/*.sh` — the fault scenarios
- `./scripts/e2e-test.sh` — the full lab-backed run

The topology, FRR configs and scenario scripts are written but have not been
run against a live containerlab. Expect the usual first-deploy friction:
container image tags, interface naming, OSPF convergence timing.

---

## Acceptance criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Git repository exists with a clean structure | Done |
| 2 | Topology starts with one documented command | Written — `./lab/deploy.sh`, not yet run |
| 3 | PC1 can communicate with PC2 | Written — `./lab/verify.sh`, not yet run |
| 4 | R2–R3 can deliberately be disconnected | Written — `01-link-failure.sh`, not yet run |
| 5 | Connectivity loss is visible | Written — not yet run |
| 6 | Network restores without a rebuild | Written — `03-restore-network.sh`, not yet run |
| 7 | Firebase Emulator Suite runs locally | **Verified** |
| 8 | Health Service starts with one documented command | **Verified** — `npm run health-service` |
| 9 | Health Service checks devices periodically | **Verified** (configurable interval, default 30s) |
| 10 | Each health check is saved to Firestore | **Verified** against the emulator |
| 11 | healthy → down creates `DEVICE_UNREACHABLE` | **Verified** against the emulator |
| 12 | down → healthy creates `DEVICE_RECOVERED` | **Verified** against the emulator |
| 13 | Service survives individual check failures | **Verified** by unit tests and by design |
| 14 | No production credentials committed | **Verified** — no key material in the repo |
| 15 | README documents setup and demonstration | Done |

Criteria 2–6 are the containerlab half and become verifiable once the
prerequisites are installed.

---

## What was built

### `lab/`
- `topology.clab.yml` — PC1–R1–R2–R3–PC2, FRRouting 10.2.1, static management
  addressing, deterministic interface naming
- `configs/r{1,2,3}/frr.conf` — OSPF area 0, per-router loopback, point-to-point
  interfaces
- `configs/daemons`, `configs/vtysh.conf` — zebra + ospfd + staticd only
- `install-prereqs.sh` — Docker Engine + Containerlab (handles Ubuntu 26.04
  having no Docker repo by falling back to the noble suite)
- `deploy.sh` / `destroy.sh` / `verify.sh`
- `scenarios/01-link-failure.sh`, `02-router-failure.sh`, `03-restore-network.sh`

### `services/health-service/`
- `src/config/devices.ts` — the single source of truth for lab addressing
- `src/config/env.ts` — validated environment configuration
- `src/checks/ping.ts` — ICMP via the system `ping` binary; distinguishes a
  device that is down from a check that could not run
- `src/checks/healthCheck.ts` — per-device check that never throws
- `src/checks/stateTracker.ts` — transition detection and event mapping
- `src/firebase/client.ts` — emulator vs production selection
- `src/firebase/repository.ts` — batched writes to the three collections
- `src/service.ts` — the periodic loop, guarded at every level
- `tests/` — 18 unit tests

### `firebase/`
- `firestore.rules` — deny all direct client access (all writes are Admin SDK)
- `firestore.indexes.json` — composite indexes for later queries

### `scripts/`
- `e2e-test.sh` — drives the full lab cycle and asserts the result
- `assert-firestore.mjs` — the acceptance assertions
- `reset-firestore.sh` — clear emulator data

### `docs/`
- `architecture.md` — layering and the key design decisions
- `data-model.md` — every collection, implemented and planned
- `incident-model.md` — Increment 3 direction

---

## Key design decisions

**Loopback checking, not management checking.** Containerlab management
interfaces stay up when the data plane breaks. If the Health Service pinged
them, breaking R2–R3 would produce no observable symptom and the demo would
prove nothing. Routers therefore carry OSPF-advertised loopbacks, and
`deploy.sh` adds host routes via R1 so the service can reach them through the
emulated network. This is the load-bearing decision in Increment 1 — see
`docs/architecture.md`.

**`ping` binary instead of a raw-socket library.** Raw ICMP needs
`CAP_NET_RAW`; `/bin/ping` already has it. No native dependencies, no setcap,
runs unprivileged.

**Baseline seeding on first observation.** A device seen as down on the very
first check produces no event. Without this, every restart would emit phantom
`device_unreachable` events.

**Exit-code discipline.** `ping` exit 1 is a real outage; any other non-zero
exit is a broken check, recorded with a `check failed:` prefix. Operational
blind spots must never be silently reported as device outages.

**In-memory state tracking.** Transition state is not persisted. On restart the
first round re-establishes a baseline. Persisting it is an Increment 3 concern,
once incidents need to survive restarts.

---

## Known gaps and follow-ups

- **Lab never deployed.** The most likely first-run issues are container image
  availability and OSPF convergence timing. `deploy.sh` waits up to 30s for
  convergence; extend it if that proves tight.
- **Scenarios 01 and 02 are indistinguishable from ICMP alone.** A link failure
  and a router failure produce identical symptoms today. Separating them is
  exactly what Increment 2's log ingestion is for.
- **`healthChecks/` grows without bound.** Every device produces a document per
  round. Fine for a lab; Increment 10 revisits retention.
- **No health endpoint on the service itself.** Nothing monitors the monitor.
- **`.env` must be created manually** from `.env.example` after cloning.

---

## Starting Increment 2

Do not begin until the lab-backed run of `./scripts/e2e-test.sh` passes.

Increment 2 adds syslog ingestion and real Layer 0 normalization: raw messages
land in `networkLogs/`, parsers turn them into `networkEvents/` with a
`sourceLogId` back-reference, and at least three event types are supported with
unit-tested normalization logic. FRR is already configured with `log stdout`,
so pointing it at a syslog collector is a small config change.
