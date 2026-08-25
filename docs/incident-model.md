# Incident Model (Increment 3 — not yet implemented)

Placeholder for the incident lifecycle and correlation design. Recorded now so
the direction is fixed; no code exists for this yet.

## Intent

Turn many normalized `networkEvents` into one `incident`.

```
r2 interface_down
r3 device_unreachable      -->    INC-001
pc2 device_unreachable            probable area: R2 <-> R3 link
ospf neighbour lost
```

## Correlation starts deterministic

The first implementation uses explicit rules, not an LLM: events within a time
window, on topologically adjacent devices, collapse into one incident. Claude
enters in Increment 4 as an investigator over incidents that already exist.

## Scenario expectations

`lab/scenarios/` is a fault-generation harness, not just a network emulator.
Each scenario will eventually declare its expected symptoms, events, incident,
probable root cause, and recovery — which is what lets the team measure whether
Layer 0 and the agent are actually improving over time.

| Scenario | Expected symptoms | Expected events | Expected cause |
|----------|-------------------|-----------------|----------------|
| `01-link-failure` | r3 + pc2 unreachable, PC1 cannot reach PC2 | `device_unreachable` x2 | R2 eth2 down |
| `02-router-failure` | r3 + pc2 unreachable | `device_unreachable` x2 | R3 node down |
| `03-restore-network` | all reachable | `device_recovered` x2 | n/a |

Note that scenarios 01 and 02 currently produce the *same* observable symptoms
from ICMP alone. Distinguishing them is precisely what Increment 2's log
ingestion and Increment 3's correlation are for.
