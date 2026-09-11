# ACN Progress

Last updated: 2026-09-09

## ISP failure simulation update

The current lab-controller surface now contains five targeted ISP-style
failures: configuration drift, logical OSPF-session failure, administratively
disabled interface, ospfd crash, and bounded CPU exhaustion affecting ospfd.
The former whole-router-stop scenario was removed; the existing interface
shutdown was retained and reclassified because it genuinely maps to the
logical-port category. The scenarios now inject faults only. Layer Zero's
autonomous read-only state observer independently polls the intended R2/R3
configuration, process state, and CPU quota, preserves the probe output, and
emits deduplicated fault/recovery transitions. `npm run
test:e2e:failure-categories` verifies that observer-to-agent path without model
credits.

Persistent state incidents now stay open until the observer confirms recovery;
healthy ICMP alone no longer resolves configuration drift or service-state
faults. Explicit root-cause impact is predicted from topology and then compared
with reachability observed independently.

| Increment | Scope                                         | Status                                                 |
| --------- | --------------------------------------------- | ------------------------------------------------------ |
| **1**     | Emulated network + Health Service + Firestore | **Complete — 15/15 criteria verified**                 |
| **2**     | Raw logs + Layer 0 normalization              | **Complete — verified against a real link failure**    |
| **3**     | Incident detection and correlation            | **Complete — both fault scenarios told apart**         |
| **4**     | GPT-5.6 Luna read-only investigation agent    | **Complete — real two-scenario live-model e2e passed** |
| 5         | Controlled network actions                    | Not started                                            |
| 6         | Risk levels and approval workflow             | Not started                                            |
| 7         | Angular NOC UI                                | Read-only dashboard pulled forward; auth still to do   |
| 8         | Historical intelligence                       | Not started                                            |
| 9         | Advanced monitoring (SNMP, gNMI, BGP/OSPF)    | Not started                                            |
| 10        | Production storage and scalability            | Not started                                            |

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

| #   | Criterion                                         | Status                                                     |
| --- | ------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Git repository exists with a clean structure      | Done                                                       |
| 2   | Topology starts with one documented command       | **Verified** — lab deployed and converged                  |
| 3   | PC1 can communicate with PC2                      | **Verified** — host → r1 → r2 → r3 → pc2 path proven       |
| 4   | R2–R3 can deliberately be disconnected            | **Verified** — `01-link-failure.sh` shuts `r2:eth2`        |
| 5   | Connectivity loss is visible                      | **Verified** — r3 and pc2 went DOWN, r1/r2/pc1 unaffected  |
| 6   | Network restores without a rebuild                | **Verified** — `03-restore-network.sh`, reconverged in ~4s |
| 7   | Firebase Emulator Suite runs locally              | **Verified**                                               |
| 8   | Health Service starts with one documented command | **Verified**                                               |
| 9   | Health Service checks devices periodically        | **Verified** against the real lab                          |
| 10  | Each health check is saved to Firestore           | **Verified** against the real lab                          |
| 11  | healthy → down creates `DEVICE_UNREACHABLE`       | **Verified** — emitted by a real link failure              |
| 12  | down → healthy creates `DEVICE_RECOVERED`         | **Verified** — emitted by a real link restore              |
| 13  | Service survives individual check failures        | **Verified** by unit tests and by design                   |
| 14  | No production credentials committed               | **Verified**                                               |
| 15  | README documents setup and demonstration          | Done                                                       |

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

| #   | Criterion                                     | Status                                     |
| --- | --------------------------------------------- | ------------------------------------------ |
| 1   | Raw log messages are stored in `networkLogs/` | **Verified** — 78 lines in one run         |
| 2   | The original text is preserved unmodified     | **Verified** — asserted on every document  |
| 3   | Logs are normalized into `networkEvents/`     | **Verified**                               |
| 4   | At least three event types are supported      | **Verified** — four                        |
| 5   | Normalized events carry `sourceLogId`         | **Verified** — every one resolves          |
| 6   | Normalization logic is unit tested            | **Verified** — 25 tests, real-log fixtures |
| 7   | Unparseable lines are not discarded           | **Verified** — stored with `parsed: false` |
| 8   | Collection survives Firestore failure         | **Verified** — unit tested                 |
| 9   | Increment 1 is unaffected                     | **Verified** — e2e re-run green            |

---

## Increment 3 — status

Complete. `./scripts/e2e-incidents.sh` runs the whole stack against the real lab
through **both** fault scenarios and passes all 16 assertions.

The Incident Service watches `networkEvents/`, groups related events into
`incidents/`, and infers a probable root cause deterministically - no LLM, which
arrives in Increment 4 as an investigator over incidents that already exist.

### The result that matters

```
INC-001 [resolved] R2 <-> R3 link failure (confirmed)
INC-002 [resolved] R3 device failure (probable)
```

Both scenarios produce an **identical** set of `device_unreachable` events
(`pc2`, `r3`), so ICMP alone cannot separate them. The discriminator is whether
the far end of the link corroborated:

- Link cut: r2 and r3 each report losing the other. Both are alive; the link is not.
- Router stopped: only r2 reports. r3 says nothing and is unreachable - a failed
  device cannot report its own failure.

Each root cause also states what it _predicts_ should be unreachable, derived by
removing the failed link or device from the topology graph, and stores that next
to what was observed:

```
predicted unreachable: pc2, r3 | observed: pc2, r3 | MATCH
```

### Verified on this machine

- **39/39 Incident Service unit tests**, plus 18 + 25 from Increments 1-2 (82 total).
- Fixtures are the event sequences captured from live runs of scenarios 01 and
  02, not invented.
- Full traceability asserted end to end: incident -> `eventIds` ->
  `networkEvents` -> `sourceLogId` -> `networkLogs` raw line.
- Every incident resolved once the network recovered.
- Increments 1 and 2 e2e re-run green.

### What was built

`services/incident-service/`

- `src/config/topology.ts` - adjacency, router-id mapping, and graph reachability
- `src/correlation/rootCause.ts` - the link-vs-device inference and its self-check
- `src/correlation/correlator.ts` - grouping, settle window, lifecycle
- `src/firebase/repository.ts` - `onSnapshot` on networkEvents, incidents keyed by incidentId
- `tests/` - 39 unit tests

`apps/web/` - Angular NOC dashboard, live telemetry/AI view with manual local-lab controls (see below).

`scripts/e2e-incidents.sh`, `scripts/assert-incidents.mjs`,
`scripts/lib/services.sh`.

### The traps this increment uncovered

1. **Stopping a container destroys its containerlab veth pairs**, and starting
   it back does not recreate them: the container returns with only eth0, FRR
   reads its config happily, and OSPF sits at zero neighbours. Scenario 02 was
   therefore unrecoverable by scenario 03 - never noticed, because only scenario
   01 was ever exercised by a test. `03-restore-network.sh` now redeploys the
   links when it restarts a container.

2. **`setsid npx tsx` cannot be reliably killed.** It builds a four-deep chain
   (`npx` -> `npm exec` -> `sh -c` -> `node`) and signalling `$!` orphans the
   node process. Two runs were corrupted before this was found: one left a
   Health Service writing events 39 minutes after its test finished, another
   left a second Incident Service fighting the first over the same `INC-001`
   document. **Every event type appearing exactly twice in the results is the
   signature.** All three e2e scripts now run the built `dist/index.js` - one
   process, killable - through `scripts/lib/services.sh`, which also sweeps
   leftovers before and after every run.

3. **Do not resolve incidents by matching each fault to a recovery.** FRR log
   timestamps have one-second resolution, so an interface down/up pair inside
   the same second arrives in arbitrary order; seen "up" first, the trailing
   "down" re-opens a fault nothing ever clears and the incident hangs open
   forever. Recovery events also go missing when the collector reattaches its
   tail during a redeploy. Native connectivity-fault resolution follows
   observed reachability instead; persistent state faults require an explicit
   observer recovery.

4. **A recovered device will exonerate itself if you let it.** Re-inferring the
   root cause after r3 came back - and started logging again - turned a
   correctly diagnosed device failure into a "confirmed link failure". The
   diagnosis is now frozen once definite, and only ever judged on events before
   the first recovery.

## Acceptance criteria — Increment 3

| #   | Criterion                                             | Status                                           |
| --- | ----------------------------------------------------- | ------------------------------------------------ |
| 1   | Related events correlate into one incident            | **Verified**                                     |
| 2   | Incidents carry a probable root cause                 | **Verified**                                     |
| 3   | A link failure is distinguished from a device failure | **Verified** — the headline result               |
| 4   | Correlation is deterministic and explainable          | **Verified** — evidence stored in plain language |
| 5   | Incidents resolve when the network recovers           | **Verified**                                     |
| 6   | Incidents trace back to their events and raw logs     | **Verified**                                     |
| 7   | Correlation logic is unit tested                      | **Verified** — 39 tests on captured sequences    |
| 8   | Increments 1 and 2 unaffected                         | **Verified** — both e2e re-run green             |

---

## Increment 4 — status

Implemented on `4-increment-4-gpt-investigator`. The Agent Service watches
settled `incidents/`, follows the complete evidence chain into normalized
events and verbatim router logs, asks `gpt-5.6-luna` for an independent
structured diagnosis, and writes the lifecycle and result to `agentRuns/`.

This layer is read-only by construction: it has Firestore read access and one
write target (`agentRuns/`), but no Docker, SSH, `vtysh`, Network Controller or
action tool. GPT cannot remediate, and a model/API failure cannot affect the
Health, Layer 0 or Incident services.

### What was built

`services/agent-service/`

- Responses API client pinned to `gpt-5.6-luna`, `reasoning.effort: low`,
  structured JSON output and `store: false`
- one deterministic run id per incident diagnosis version, preventing
  duplicate paid calls on listener replay or recovery events
- live `collecting_evidence` -> `analyzing` -> `completed|failed` lifecycle
- exact event/log references inspected, strict validation of model citations,
  and server-computed agreement/disagreement
- prompt/model/response id, token breakdown, latency, pricing snapshot and
  estimated cost retained for reproducibility
- API, timeout, output-validation and Firestore failures isolated per run

`apps/web/`

- live GPT investigator panel showing work in progress, baseline vs model
  conclusion, agreement/disagreement, reasoning, usage and cost
- expandable cited events that lead to the original raw device line
- reproduction prompt available in the read-only detail view

`scripts/e2e-agent.sh`, `scripts/assert-agent.mjs` — drives the two real fault
scenarios and asserts the full evidence and accounting contract when an
`OPENAI_API_KEY` is supplied.

### Verification

- 11 Agent Service unit tests use the real incident sequences and verbatim FRR
  lines captured by Increments 2 and 3.
- Tests cover request shape, strict structured response parsing, cost math,
  evidence citations, agreement and disagreement, duplicate suppression, and
  recording a model failure without throwing.
- **109/109 tests pass**: 18 Health, 33 Layer 0, 43 Incident, 11 Agent, and
  4 Lab Controller tests.
- The complete production build passes: all five strict TypeScript services
  and the Angular dashboard.
- The emulator-backed missing-key path was verified with an isolated real
  Firestore fixture. It persisted a `failed` Luna run with low reasoning,
  event/log evidence references, the full prompt, a completion timestamp and
  the expected credential error, then shut down cleanly.
- New shell and Node e2e/assertion scripts pass syntax checks; `git diff
--check` is clean.
- The paid live-model e2e passed against both real lab scenarios on 2026-08-26:
  Luna correctly identified the R2–R3 link failure and the R3 router failure,
  agreed with both deterministic conclusions, cited real events and logs, and
  recorded usage, latency and cost. No key is committed.

## Acceptance criteria — Increment 4

| #   | Criterion                                                      | Status                                              |
| --- | -------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `agentRuns/` document created per diagnosis                    | **Verified against the Firestore emulator**         |
| 2   | Inspected and cited event/log ids resolve                      | **Verified against both real scenarios**            |
| 3   | Conclusion stored beside baseline with agreement               | **Verified — Luna agreed with both baselines**      |
| 4   | Both real fault scenarios produce different conclusions        | **Verified against the live API**                   |
| 5   | Token usage, latency and cost recorded                         | **Verified against the live API**                   |
| 6   | API failure records a failed run without disturbing monitoring | **Verified against the Firestore emulator**         |
| 7   | Dashboard shows agent lifecycle and result live                | **Verified; interactive visualizer implemented**    |
| 8   | No credentials committed                                       | Verified                                            |
| 9   | Increments 1–3 remain green                                    | **Verified — full 109-test regression suite passes** |

### Operator visualizer update

The dashboard now supports the complete human-driven demonstration without
switching between terminals:

- a timestamped live timeline merges health probes, raw FRR output, normalized
  events, incident state, manual controller output and Luna's investigation
- filters isolate problems, AI activity or raw device logs
- buttons trigger five predefined fault scenarios and network restore
- `services/lab-controller` binds to `127.0.0.1:8787`, accepts no arbitrary
  command/target parameters, refuses concurrent actions and audits output to
  `labActions/`
- the browser remains unable to write Firestore, and the Agent Service remains
  unable to call the Lab Controller

The real Restore route was invoked through the controller and verified in
Firestore as `completed`, exit code 0, with six streamed output lines. The
Angular production build and browser-SDK read of `labActions/` both pass.

`npm run start:all` now owns the complete interactive startup lifecycle. It
checks the key before touching the lab, builds, repairs/deploys the topology when
needed, starts every component with separate retained logs, selects a safe
dashboard port and cleans up its process groups and lock on Ctrl+C. A real
no-cost startup/ready/shutdown cycle was verified; ports 8080, 8787 and 4200 all
closed and the lock was removed after shutdown.

## The operator visualizer (`apps/web`)

Angular, live against the Firestore emulator on
<http://localhost:4200> via `npm run web`.

**This is Increment 7's UI pulled forward deliberately** — a correlation engine
you cannot watch working is hard to trust. It now includes a unified timeline
  for health checks, raw logs, events, incidents, controller actions and Luna, plus
  six named synthetic-lab controls through a separate localhost-only service.
Authentication, per-user authorisation, incident acknowledgement and
operator-triggered agent interaction remain Increment 7.

Answering the question that prompted it: **a real Firebase project was not
needed.** A browser app connects to the emulator with the ordinary Firebase SDK,
live `onSnapshot` listeners included, so nothing about the UI has to change when
a real project arrives in Increment 10 - and the repo stays credential-free with
`reset-firestore.sh` still working.

The one real blocker was `firebase/firestore.rules`, which denied all client
access. Reads are now open for the seven collections the dashboard renders;
**client writes stay denied everywhere**, as do reads of the collections later
increments add. That is safe only against a local emulator holding synthetic
data, and the rules file says so loudly.

The manual buttons do not weaken the Agent Service boundary. They call the
separate `services/lab-controller` on `127.0.0.1:8787`, which maps exactly three
named routes to existing lab scripts, refuses concurrent operations and writes
its output to `labActions/`. It accepts no arbitrary command or target, and GPT
has no connection to it.

## Known gaps and follow-ups

- **The lab does not survive a host reboot.** Containers restart, but the
  containerlab veth pairs and the host routes do not. FRR keeps its config, so
  the symptom is misleading: routers look healthy but OSPF has zero neighbours
  and `eth1`/`eth2` are simply absent. Recovery is
  `containerlab deploy --topo lab/topology.clab.yml --reconfigure` followed by
  re-adding the two host routes (needs sudo).
- **`06-restore-network.sh` depends on the host routes.** Its convergence check
  pings `10.255.0.3` from the host, so without the routes it fails even when the
  lab itself is perfectly healthy.
- **The autonomous observer is deliberately lab-specific.** It uses fixed,
  read-only Docker/FRR commands for the five supported scenarios. General
  SNMP/gNMI discovery and vendor-neutral intent models remain Increment 9.
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

## Increment 5 — evidence-first GPT root-cause evaluation

Implemented on `5-increment-5-gpt-evidence-first-root-cause`:

- GPT receives neutral observations and raw device logs, with no deterministic
  root cause, incident symptom or cause-revealing event type in its prompt.
- Agent run identity is independent of the deterministic mapper.
- Successful controller-triggered faults record lab-only ground truth in a
  separate collection; failed actions and restores create no truth.
- Ground truth is associated atomically but withheld from `agentRuns` until GPT
  has returned a cited conclusion.
- Completed runs score cause type and device set independently. Direct scripts
  and production-style incidents remain valid, explicitly unscored runs.
- The dashboard reveals lab truth beside GPT's answer only after completion.
- **111/111 unit tests pass**, the five-category credit-free blind-evidence E2E
  passes, and the isolated Firestore evaluation-boundary E2E proves one-time
  truth claiming, stale-incident rejection and post-completion reveal.

The detailed trust boundaries and exit criteria are in
`docs/increment-5-plan.md`. Controlled remediation moves to Increment 6 and
must retain a separate allow-listed action and approval boundary.

## Increment 6 — guarded AI remediation

Started on `6-increment-6-guarded-ai-remediation`. The approved design is in
`docs/increment-6-plan.md` and the first safety-contract slice is implemented:

- a separate Network Controller package owns the only future mutation boundary;
- GPT-facing requests are limited to five fixed repair intents or explicit
  escalation, with no caller-controlled target or command fields;
- strict parsing rejects unknown fields, arbitrary commands, arbitrary targets,
  invalid IDs and unbounded evidence lists;
- deterministic idempotency prevents duplicate proposals from executing twice;
- every mutation requires human approval and an incident-version recheck;
- preflight must prove the expected fault is still present;
- success requires observer recovery evidence, never only command exit zero;
- ordered audit transitions cover proposed, approved, executing, verifying and
  terminal states.

The live device adapter, Firestore repository, approval API, model proposal and
dashboard approval card remain the next implementation slices. No live network
mutation is connected yet.
