# Incident Model (Increment 3 — implemented)

Turn many normalized `networkEvents` into one `incident` with a probable root
cause, deterministically and explainably.

```
r2 interface_down
r2 ospf_neighbor_down -> r3
r3 interface_down                 -->    INC-001
r3 ospf_neighbor_down -> r2              R2 <-> R3 link failure (confirmed)
r3 device_unreachable
pc2 device_unreachable
```

## The question that separates a link failure from a device failure

This is the whole of Increment 3, and the reason Increment 2 had to exist:

> **Did the far end of the link corroborate?**

| | Link failure (scenario 01) | Device failure (scenario 02) |
|---|---|---|
| r2 reports | `interface_down`, `ospf_neighbor_down` → r3 | `interface_down`, `ospf_neighbor_down` → r3 |
| r3 reports | `interface_down`, `ospf_neighbor_down` → r2 | **nothing — it is gone** |
| ICMP shows | r3, pc2 unreachable | r3, pc2 unreachable |

Both ends complaining about each other means both devices are alive and the
link between them is not. One end complaining while the silent peer is itself
unreachable means that peer failed — a dead router cannot file a report.

The ICMP row is identical in both columns. That is not a detail: it is the
proof that Increment 1 alone could never have told these apart, and that the
log evidence is what settles it.

## Correlation is deterministic, not an LLM

The first implementation uses explicit rules: events within a time window, on
topologically adjacent devices, collapse into one incident. Claude arrives in
Increment 4 as an investigator over incidents that already exist.

An inference nobody can reproduce is not a baseline. Every conclusion here can
be re-derived by hand from the stored events, and the incident records the
evidence in plain language so it can be argued with.

## Self-checking: predicted vs observed

Each root cause states which devices it *implies* should be unreachable, by
removing the failed link or device from the topology graph and asking what is
still reachable from r1 (where the monitoring host enters the data plane). That
prediction is stored next to what was actually observed.

```
predicted unreachable: pc2, r3 | observed: pc2, r3 | MATCH
```

A root cause that does not predict the observed symptoms is a root cause worth
doubting, so the mismatch is recorded rather than hidden. It is the signal that
the correlation rules need work.

## Lifecycle

An incident opens on the first fault event that no open incident already
covers. It absorbs related events — same device, an adjacent device, or a named
OSPF peer already implicated — within the correlation window.

**The root cause is judged only after a settle window**, and only from events
before the first recovery. Two hard-won reasons:

- Judged immediately, every link failure would briefly be misreported as a
  device failure, because the far end has not had time to corroborate yet.
- Judged again after recovery, a restored router would retrospectively
  exonerate itself: r3 comes back, starts logging, and a correctly diagnosed
  device failure turns into a "confirmed link failure".

Once a definite conclusion is reached it is frozen. The diagnosis describes what
broke; recovery is not evidence about that.

**Resolution follows observed reachability**, deliberately not a tally of faults
matched against recoveries. That tally is unreliable against real telemetry:

- FRR log timestamps have one-second resolution, so an interface down/up pair
  inside the same second can be delivered in either order. Seen "up" first, the
  trailing "down" re-opens a fault nothing will ever clear and the incident
  hangs open forever. This happened.
- Recovery events can simply be missed — the collector reattaches its tail when
  the lab is redeployed and the log files are recreated.

The Health Service re-checks reachability every round, so "is anything still
unreachable" is a self-correcting question where "did every fault get an ack" is
not.

## Scenario expectations

`lab/scenarios/` is a fault-generation harness, not just a network emulator.

| Scenario | Expected symptoms | Expected root cause | Confidence |
|----------|-------------------|---------------------|------------|
| `01-link-failure` | r3 + pc2 unreachable | R2 <-> R3 link failure | `confirmed` |
| `02-router-failure` | r3 + pc2 unreachable | R3 device failure | `probable` |
| `03-restore-network` | all reachable | incidents resolve | n/a |

`./scripts/e2e-incidents.sh` runs 01 and 02 in sequence and asserts that they
produce *different* root causes from *identical* observed symptoms.

## What Layer 0 and the Incident Service each refuse to do

Layer 0 emits events and stops; it never decides what is an incident.
The Incident Service correlates and diagnoses; it never remediates.

Both boundaries are deliberate. Putting correlation in the normalizer would
make it impossible to change without re-parsing history, and putting
remediation here would skip the risk policy that Increments 5 and 6 exist to
provide.

## Known limits

- **In-memory correlation state.** On restart the service resumes from the
  current moment, like the Health Service's baseline and Layer 0's tail.
  Incident ids continue from the highest already in Firestore.
- **Single instance.** Two correlators writing the same `INC-001` document will
  fight. Not a concern for a lab; Increment 10's problem.
- **Topology is static**, declared in `services/incident-service/src/config/topology.ts`
  to mirror `lab/topology.clab.yml`. Discovery is out of scope.
- **Two simultaneous unrelated faults on adjacent devices** would merge into one
  incident. Merging two views of one fault is far less harmful than splitting
  one fault in two, so the window errs that way on purpose.
