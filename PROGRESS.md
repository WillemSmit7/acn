# ACN Progress

Last updated: 2026-08-25

| Increment | Scope | Status |
|-----------|-------|--------|
| **1** | Emulated network + Health Service + Firestore | **Complete — 15/15 criteria verified** |
| **2** | Raw logs + Layer 0 normalization | **Complete — verified against a real link failure** |
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

Increment 1 is **complete**. `./scripts/e2e-test.sh` has been run end to end
against the real lab and passes: healthy baseline → R2–R3 link broken →
`device_unreachable` observed → link restored → `device_recovered` observed →
Firestore assertions pass. All 15 acceptance criteria are verified.

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

### End-to-end run

`./scripts/e2e-test.sh` on 2026-08-25, 5-second interval, against the deployed
lab and the Firestore emulator:

```
[20:56:27] r3   DOWN    no reply within timeout
[20:56:27] pc2  DOWN    no reply within timeout
[20:56:27] EVENT DEVICE_UNREACHABLE device=r3 severity=critical
[20:56:27] EVENT DEVICE_UNREACHABLE device=pc2 severity=critical
[20:57:00] r3   healthy 0.039ms
[20:57:00] pc2  healthy 0.057ms
[20:57:00] EVENT DEVICE_RECOVERED device=r3 severity=info
[20:57:00] EVENT DEVICE_RECOVERED device=pc2 severity=info
```

Final state: `devices/ 5, healthChecks/ 45, networkEvents/ 4`, all eight
assertions in `assert-firestore.mjs` passing.

The important detail is what did **not** happen: r1, r2 and pc1 stayed healthy
through the entire outage. The fault is reported with the correct blast radius —
only the devices behind the broken link — which is what makes the loopback
decision worth its cost. Reconvergence after `no shutdown` took ~4s.

## Acceptance criteria — Increment 1

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Git repository exists with a clean structure | Done |
| 2 | Topology starts with one documented command | **Verified** — lab deployed and converged |
| 3 | PC1 can communicate with PC2 | **Verified** — host → r1 → r2 → r3 → pc2 path proven |
| 4 | R2–R3 can deliberately be disconnected | **Verified** — `01-link-failure.sh` shuts `r2:eth2` |
| 5 | Connectivity loss is visible | **Verified** — r3 and pc2 went DOWN, r1/r2/pc1 unaffected |
| 6 | Network restores without a rebuild | **Verified** — `03-restore-network.sh`, reconverged in ~4s |
| 7 | Firebase Emulator Suite runs locally | **Verified** |
| 8 | Health Service starts with one documented command | **Verified** |
| 9 | Health Service checks devices periodically | **Verified** against the real lab |
| 10 | Each health check is saved to Firestore | **Verified** against the real lab |
| 11 | healthy → down creates `DEVICE_UNREACHABLE` | **Verified** — emitted by a real link failure |
| 12 | down → healthy creates `DEVICE_RECOVERED` | **Verified** — emitted by a real link restore |
| 13 | Service survives individual check failures | **Verified** by unit tests and by design |
| 14 | No production credentials committed | **Verified** |
| 15 | README documents setup and demonstration | Done |

15 of 15 verified. Criteria 4–6 and 11–12 were all cleared by the single
end-to-end run above, driven by an actual R2–R3 link failure rather than a
synthetic target set.


## What was built — Increment 1

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

## Increment 2 — status

Complete. `./scripts/e2e-layer-zero.sh` runs the Health Service and Layer 0
together against the real lab and passes all 16 assertions.

Layer 0 tails each router's FRR logs, stores every line verbatim in
`networkLogs/`, and normalizes the meaningful ones into `networkEvents/` with a
`sourceLogId` back-reference to the exact line they came from.

### Verified on this machine

- **25/25 Layer 0 unit tests pass**, plus the 18 from Increment 1 (43 total).
  Every parser fixture is a line copied verbatim out of the running lab.
- **Four event types normalized**, one more than the three required:
  `interface_down`, `interface_up`, `ospf_neighbor_down`, `ospf_neighbor_up`.
- **Observed from a real R2-R3 link failure:**

  ```
  [21:33:53] EVENT INTERFACE_DOWN      device=r2 interface=eth2
  [21:33:53] EVENT OSPF_NEIGHBOR_DOWN  device=r2 interface=eth2 neighbor=10.255.0.3
  [21:33:53] EVENT INTERFACE_DOWN      device=r3 interface=eth1
  [21:33:53] EVENT OSPF_NEIGHBOR_DOWN  device=r3 interface=eth1 neighbor=10.255.0.2
  [21:34:04] EVENT INTERFACE_UP        device=r2 interface=eth2
  [21:34:14] EVENT OSPF_NEIGHBOR_UP    device=r2 interface=eth2 neighbor=10.255.0.3
  ```

  The failure is seen independently from **both ends** of the link, each router
  naming the other as the lost neighbour. That is the raw material Increment 3
  needs to tell a link fault from a single-device fault.

- **Traceability holds end to end.** Every layer-zero event resolves through
  its `sourceLogId` to a real `networkLogs` document, e.g.
  `ospf_neighbor_down` -> `AdjChg: Nbr 10.255.0.3, ... Full -> Deleted (KillNbr)`.
- **Both producers coexist.** A single run produced 78 raw logs and 13 events,
  9 from Layer 0 and 4 from the Health Service, in one `networkEvents`
  collection distinguished by `source`.
- **Increment 1 still passes** — `./scripts/e2e-test.sh` re-run green after the
  changes.

### What was built

`services/layer-zero/`
- `src/collector/logTail.ts` — follows log files inside a container, restarts a
  dead tail, buffers partial lines
- `src/normalize/parser.ts` — FRR line -> structured envelope, UTC-correct
- `src/normalize/rules.ts` — envelope -> network event, or nothing
- `src/pipeline.ts` — buffering, batched writes, failure isolation
- `src/firebase/repository.ts` — writes the raw log and its event in one batch
- `tests/` — 25 unit tests

`scripts/e2e-layer-zero.sh`, `scripts/assert-layer-zero.mjs` — the Increment 2
end-to-end test and its assertions.

Lab changes: per-daemon FRR log files via `--log` startup flags in
`lab/configs/daemons`, `debug zebra events` and `log-adjacency-changes detail`
in each `frr.conf`, and a `lab/logs/<router>` bind mount created by `deploy.sh`.

### The traps this increment uncovered

All four were **silent failures** — the daemon stayed up, the config read back
correctly, and the events simply were not there:

1. **`docker logs` is useless for FRR.** It daemonizes; after startup nothing
   reaches the container's stdout.
2. **ospfd and staticd reject a runtime `log file`** for any path, including
   world-writable ones, while zebra and mgmtd accept it. Set log destinations
   as `--log file:` startup flags instead.
3. **`/var/run/frr` is not writable by ospfd.** zebra opens its log while still
   root; ospfd opens its own after dropping to the `frr` user and fails. Hence
   the `/var/log/frr` bind mount, mode 777.
4. **Those files are root-owned mode 600 on the host**, so host-side reading
   needs root. Collection goes through `docker exec … tail -F`.

Also fixed: `scripts/e2e-test.sh` killed only the npm wrapper, orphaning the
Health Service, which kept writing to the emulator and silently polluted later
runs. Both e2e scripts now start services with `setsid` and signal the process
group.

## Acceptance criteria — Increment 2

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Raw log messages are stored in `networkLogs/` | **Verified** — 78 lines in one run |
| 2 | The original text is preserved unmodified | **Verified** — asserted on every document |
| 3 | Logs are normalized into `networkEvents/` | **Verified** |
| 4 | At least three event types are supported | **Verified** — four |
| 5 | Normalized events carry `sourceLogId` | **Verified** — every one resolves |
| 6 | Normalization logic is unit tested | **Verified** — 25 tests, real-log fixtures |
| 7 | Unparseable lines are not discarded | **Verified** — stored with `parsed: false` |
| 8 | Collection survives Firestore failure | **Verified** — unit tested |
| 9 | Increment 1 is unaffected | **Verified** — e2e re-run green |

---

## Known gaps and follow-ups

- **The lab does not survive a host reboot.** Containers restart, but the
  containerlab veth pairs and the host routes do not. FRR keeps its config, so
  the symptom is misleading: routers look healthy but OSPF has zero neighbours
  and `eth1`/`eth2` are simply absent. Recovery is
  `containerlab deploy --topo lab/topology.clab.yml --reconfigure` followed by
  re-adding the two host routes (needs sudo).
- **`03-restore-network.sh` depends on the host routes.** Its convergence check
  pings `10.255.0.3` from the host, so without the routes it fails even when the
  lab itself is perfectly healthy.
- **Scenarios 01 and 02 are now distinguishable.** A link failure logs
  `interface_down` on both ends; a router failure takes the whole device away
  and logs nothing from it. Increment 3 gets to exploit that.
- **`networkLogs/` grows without bound**, like `healthChecks/`. Retention is an
  Increment 10 concern.
- **Layer 0 resumes at the end of the file.** A tail restart or a service
  restart does not replay lines written while it was away. Persisting a read
  offset is deferred; in a lab the collector is running whenever it matters.
- **pc1 and pc2 produce no logs.** They run no routing daemon, so they are
  ICMP-only. Their unreachability is still observed by the Health Service.
- **`healthChecks/` grows without bound.** Every device produces a document per
  round. Fine for a lab; Increment 10 revisits retention.
- **No health endpoint on the service itself.** Nothing monitors the monitor.
- **`.env` must be created manually** from `.env.example` after cloning.

---

## Starting Increment 3

Increment 3 turns the event stream into incidents: correlate the
`interface_down` / `ospf_neighbor_down` events from r2 and r3 with the
`device_unreachable` events for r3 and pc2 into a single incident with a
probable root cause, and close it when the recovery events arrive.

Everything it needs is now in `networkEvents/` on a common `deviceId`, with the
raw evidence one `sourceLogId` lookup away. See `docs/incident-model.md`.
