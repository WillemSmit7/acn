# ACN Progress

Last updated: 2026-08-25

| Increment | Scope | Status |
|-----------|-------|--------|
| **1** | Emulated network + Health Service + Firestore | **Lab live; 11/15 criteria verified** |
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

Docker and Containerlab are now installed, the lab is **deployed and OSPF has
converged**, and the Health Service has been run against the real topology.
What remains is the fault half of the demo (break the link, observe the events,
restore) — see "Remaining step" below.

### Verified on this machine

- **18/18 unit tests pass** (`npm test`) — ping output parsing, exit-code
  classification, live ICMP, and the full state-transition matrix.
- **TypeScript compiles clean** under `strict` + `noUncheckedIndexedAccess`.
- **The lab is running.** All five devices answer through the emulated data
  plane, from the host:

  ```
  r1   10.255.0.1   UP  0.041ms      pc1  10.0.1.2   UP  0.046ms
  r2   10.255.0.2   UP  0.058ms      pc2  10.0.3.2   UP  0.042ms
  r3   10.255.0.3   UP  0.037ms
  ```

  Reaching `10.0.3.2` (pc2) from the host traverses r1 → r2 → r3 → pc2, so this
  single result proves the whole data path, OSPF convergence, and the host
  routes installed by `deploy.sh`.

- **The Health Service runs against the real lab**, not a synthetic target set:

  ```
  [20:07:50] Synced 5 device record(s) to Firestore
  [20:07:50] r1   healthy 0.021ms
  [20:07:50] r2   healthy 0.032ms
  [20:07:50] r3   healthy 0.045ms
  [20:07:50] pc1  healthy 0.043ms
  [20:07:50] pc2  healthy 0.048ms
  ```

  Firestore received all five `devices/` records and five `healthChecks/`
  documents carrying true sub-millisecond latencies (0.02–0.048ms) and server
  timestamps.

- **State transitions verified against the emulator** (earlier, with a
  controllable target set): a healthy → down → healthy cycle produced exactly
  `device_unreachable` then `device_recovered`, and no phantom event on the
  baseline round.
- **`assert-firestore.mjs` verified both ways** — passes on correct data, fails
  on an empty database.

### Remaining step

Breaking the R2–R3 link needs `docker exec`, and the agent session driving this
work started before `usermod -aG docker` took effect, so its process does not
carry the `docker` group. Everything else was reachable because ICMP needs no
Docker access.

With the lab and the Firestore emulator already running, one command in a
**freshly opened terminal** finishes the increment:

```bash
./scripts/e2e-test.sh
```

It clears the emulator, restores the baseline, starts the service on a 5-second
interval, breaks the R2–R3 link, restores it, and asserts the resulting
Firestore contents.

## Acceptance criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Git repository exists with a clean structure | Done |
| 2 | Topology starts with one documented command | **Verified** — lab deployed and converged |
| 3 | PC1 can communicate with PC2 | **Verified** — host → r1 → r2 → r3 → pc2 path proven |
| 4 | R2–R3 can deliberately be disconnected | Pending — needs `docker exec` |
| 5 | Connectivity loss is visible | Pending — needs criterion 4 |
| 6 | Network restores without a rebuild | Pending — needs `docker exec` |
| 7 | Firebase Emulator Suite runs locally | **Verified** |
| 8 | Health Service starts with one documented command | **Verified** |
| 9 | Health Service checks devices periodically | **Verified** against the real lab |
| 10 | Each health check is saved to Firestore | **Verified** against the real lab |
| 11 | healthy → down creates `DEVICE_UNREACHABLE` | **Verified** against the emulator |
| 12 | down → healthy creates `DEVICE_RECOVERED` | **Verified** against the emulator |
| 13 | Service survives individual check failures | **Verified** by unit tests and by design |
| 14 | No production credentials committed | **Verified** |
| 15 | README documents setup and demonstration | Done |

11 of 15 verified. Criteria 4–6 are the fault-injection half and clear together
the moment `./scripts/e2e-test.sh` runs with Docker access. Criteria 11 and 12
are verified as logic and persistence, but not yet driven by a real link failure.


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
