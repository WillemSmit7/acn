# Function Diagrams

This document collects flow diagrams for specific ACN logic units. The diagrams
show each unit's inputs, transformations, decisions, and outputs.

## Layer 0

Layer 0 has two independent inputs: FRR daemon log files and periodic router
state probes. Both paths use `networkLogs/` for evidence and
`networkEvents/` for recognized transitions.

```mermaid
flowchart TD
  subgraph FRR["A. FRR log collector"]
    A["zebra.log + ospfd.log<br/>on R1, R2, R3"]
    B["docker exec … tail -F<br/>read new complete lines"]
    C["Parse FRR envelope<br/>timestamp, daemon, code, message"]
    D{"Recognized log pattern?"}
    E["Keep raw line<br/>parsed=false or normalized=false"]
    F["Normalize into event<br/>e.g. interface_down,<br/>ospf_neighbor_down"]
    G["Batch write"]
    H[("Firestore: networkLogs/")]
    I[("Firestore: networkEvents/")]
    A --> B --> C --> D
    D -- "No / unparseable" --> E --> G --> H
    D -- "Yes" --> F --> G
    G --> H
    G -- "only when an event was produced" --> I
  end
```

```mermaid
flowchart TD
  subgraph PROBE["B. Router-state observer"]
    J["Periodically inspect R2/R3<br/>via Docker probes"]
    K["Extract facts<br/>config, process state, CPU quota"]
    L{"Did a known condition<br/>change state?"}
    M["No transition<br/>no event or probe record"]
    N["Create fault/recovery observation<br/>with exact probe output"]
    O["Pipeline batches evidence + event"]
    P[("Firestore: networkLogs/")]
    Q[("Firestore: networkEvents/")]
    J --> K --> L
    L -- "No: unchanged" --> M
    L -- "Yes: fault or recovery" --> N --> O
    O --> P
    O --> Q
  end
```

### FRR log path

Layer 0 follows `zebra.log` and `ospfd.log` on R1–R3. For each complete line,
the parser extracts the timestamp, daemon, message code, and message. Parsing
only identifies the line's structure; normalization applies rules to decide
whether it represents a meaningful event.

Every collected line is retained in `networkLogs/`, including unparseable
lines, routine messages, and lines that do not match an event rule. Recognized
lines also produce normalized events in `networkEvents/`, such as
`interface_down` or `ospf_neighbor_down`. Each such event points back to its
exact raw log document with `sourceLogId`. Writes are buffered and batched.

### Router-state probe path

Separately, Layer 0 periodically reads selected state from R2 and R3. Probes
inspect facts such as R2's OSPF/interface configuration and R3's OSPF process
and CPU quota. The observer compares those facts with known conditions and
remembers whether each condition was active on the previous poll.

An unchanged condition produces no event and no saved probe record. When a
known condition changes, the observer emits a fault or recovery observation.
The exact probe output is retained in `networkLogs/`, and the transition is
written to `networkEvents/`.

Layer 0 recognizes and records observations; it does not correlate them into
incidents, determine a final root cause, or take corrective action.

## Health Service

The Health Service pings configured data-plane addresses. It stores every
check result but creates network events only for reachability state changes.

```mermaid
flowchart TD
  A["Configured enabled devices<br/>and check addresses"]
  B["On each check interval,<br/>run ICMP ping per device"]
  C["Classify result<br/>reachable + latency, or down + error"]
  D["Create one health-check result<br/>per device per round"]
  E[("Firestore: healthChecks/<br/>every result is stored")]
  F{"Compare status with<br/>previous status in memory"}
  G["First observation<br/>seed baseline; no event"]
  H["Status unchanged<br/>no event"]
  I["Status changed"]
  J["Map transition to event<br/>down → device_unreachable<br/>healthy → device_recovered"]
  K[("Firestore: networkEvents/<br/>sourceLogId = null")]
  A --> B --> C --> D --> E
  D --> F
  F -- "First check" --> G
  F -- "Same status" --> H
  F -- "Changed" --> I --> J --> K
```

The service runs ICMP pings against enabled devices' configured check
addresses. Each round produces and stores a health-check result in
`healthChecks/`, including status and latency or an error. A state tracker
compares each status with the last status held in memory:

- The first observation establishes a baseline and emits no event.
- If the status is unchanged, the result is still stored but no event is made.
- If the status changes, the service emits `device_unreachable` or
  `device_recovered` to `networkEvents/`.

These events come from ICMP checks, not FRR log lines, so their `sourceLogId`
is `null`. The `healthChecks/` collection is the history of probe results;
`networkEvents/` contains recognized transitions.

> **Check-error distinction:** the ping layer records unexpected or failed
> checks with an error, but the state tracker compares the resulting `down`
> status. A transition to that status can therefore currently produce
> `device_unreachable` even when the failure is from the check itself rather
> than confirmed device unreachability. 
>
> We can add this as a point of interest, especially if we want to make the system more robust and 
> have more context to go on by.

## Incident Service

The Incident Service consumes `networkEvents/` from both the Health Service and
Layer 0. It correlates related fault events, waits for evidence to settle,
determines a reproducible root cause, and tracks recovery. It updates
`incidents/`; it does not change the network.

```mermaid
flowchart TD
  A[("Firestore: networkEvents/<br/>Health Service + Layer 0")]
  B["Watch new events<br/>in occurrence-time order"]
  C["Validate and map event<br/>to correlation input"]
  D{"Recognized event type?"}
  E["Ignore malformed or<br/>unsupported event"]
  F{"Fault or recovery?"}
  G["Find related open incident<br/>same/adjacent device or named peer<br/>within correlation window"]
  H{"Related incident found?"}
  I["Open incident<br/>assign next INC-### ID"]
  J["Attach fault event<br/>update affected devices,<br/>symptoms and outstanding state"]
  K["Match recovery to its fault<br/>update outstanding state;<br/>unmatched recovery is ignored"]
  L["Periodic evaluation tick"]
  M{"Quiet for settle window?"}
  N["Keep root cause as analyzing"]
  O["Use fault-phase evidence<br/>before first recovery"]
  P["Infer deterministic root cause<br/>explicit probe faults first;<br/>then link/device evidence"]
  Q["Predict unreachable devices<br/>from topology and cause"]
  R["Compare prediction with<br/>observed unreachable devices"]
  S{"All unreachable and<br/>persistent faults cleared,<br/>settled and quiet?"}
  T["Keep incident open;<br/>update current state"]
  U["Mark incident resolved"]
  V["Batch write/update incident<br/>document by INC-###"]
  W[("Firestore: incidents/<br/>current incident state")]

  A --> B --> C --> D
  D -- "No" --> E
  D -- "Yes" --> F
  F -- "Fault" --> G --> H
  H -- "No" --> I --> J
  H -- "Yes" --> J
  F -- "Recovery" --> K
  J --> L
  K --> L
  L --> M
  M -- "No" --> N --> V
  M -- "Yes" --> O --> P --> Q --> R --> S
  S -- "No" --> T --> V
  S -- "Yes" --> U --> V
  V --> W
```

### Event ingestion and correlation

The service watches newly added `networkEvents/` documents, ordered by
occurrence time. A document without the required timestamp, device id, or
event type is discarded by the repository mapper. The correlator ignores
unsupported event types.

A recognized fault either joins an open incident or starts one. It joins when
it is about a device already involved, a directly adjacent device, or a named
OSPF peer already implicated, and is within the configured correlation window.
Otherwise the service creates a new sequential incident id such as `INC-001`.
Related event ids and affected devices are accumulated on that incident.

Recovery events do not open incidents. They are matched to an outstanding
fault, update the incident's recovery state, and are ignored when there is no
matching open fault.

### Settling and diagnosis

The periodic evaluation waits for the configured quiet/settle period before
finalizing a diagnosis. This gives the other end of a failed link time to
corroborate. Diagnosis uses only the fault phase, stopping at the first
recovery event, so recovery evidence cannot rewrite what originally broke.

Root-cause inference is deterministic. Explicit state-observer findings (such
as configuration drift, a routing-service failure, or resource exhaustion)
are checked first. Otherwise, two ends reporting loss of the same link support
a link failure; one reporting while the peer is silent and unreachable supports
a device failure. If evidence is insufficient, the result can remain unknown.
The inferred cause is used with the static topology to predict what should be
unreachable, and that prediction is compared with observed reachability. A
definite diagnosis is frozen; later recovery updates the observed state without
changing the diagnosed cause.

### Recovery and output

The incident stays open while devices remain unreachable or persistent
configuration, session, administrative, service, or resource faults remain
unrecovered. Connectivity incidents use Health Service reachability as the
recovery signal; persistent-state faults need their matching recovery event.
Once the incident is settled, all tracked faults are cleared, and the required
quiet period has passed, the correlator marks it resolved.

Changed incidents are batch-written to `incidents/` using `INC-###` as the
document id. Each document holds the current incident state, including status,
severity, affected and unreachable devices, symptoms, root-cause evidence,
predicted-versus-observed reachability, and the ids of its source events. The
source events remain in `networkEvents/`; Layer 0's `sourceLogId` links
log-derived events onward to their raw `networkLogs/` evidence.

## Agent Service

The Agent Service watches diagnosed incidents and performs an independent,
read-only investigation. It loads the incident's normalized events and linked
raw log evidence, asks the configured model for a structured diagnosis, checks
the citations, compares the conclusion with the deterministic baseline, and
records the run in `agentRuns/`.

```mermaid
flowchart TD
  A[("Firestore: incidents/<br/>diagnosed incident")]
  B["Watch added/updated incidents"]
  C{"Has a supported<br/>diagnosis?"}
  D["Skip incident without<br/>a usable diagnosis"]
  E["Hash diagnosis into a version<br/>derive deterministic run id"]
  F{"Run id already active<br/>or recorded?"}
  G["Skip duplicate investigation"]
  H["Claim run transactionally<br/>status=running<br/>stage=collecting_evidence"]
  I["Load eventIds from<br/>networkEvents/"]
  J["Follow sourceLogId references<br/>to raw networkLogs/"]
  K["Build versioned prompt<br/>baseline + incident +<br/>normalized events + raw logs"]
  L["Update run stage=analyzing<br/>save evidence refs and prompt"]
  M["Call model via Responses API<br/>strict structured JSON<br/>no tools or action capability"]
  N{"Response valid and<br/>citations refer to supplied evidence?"}
  O["Compute agree/disagree<br/>against deterministic baseline"]
  P["Complete run with conclusion,<br/>citations, usage, latency and cost"]
  Q["Record run as failed<br/>with error and completion time"]
  R[("Firestore: agentRuns/<br/>lifecycle + investigation result")]
  S["No remediation path:<br/>agent cannot change network"]

  A --> B --> C
  C -- "No" --> D
  C -- "Yes" --> E --> F
  F -- "Yes" --> G
  F -- "No" --> H --> I --> J --> K --> L --> M --> N
  N -- "Yes" --> O --> P --> R
  N -- "No / request or processing error" --> Q --> R
  M -.-> S
```

### Input and evidence preparation

The service watches incident documents as they are added or modified. It only
accepts incidents with a supported deterministic root-cause record; an
incident still marked as analyzing is not investigable. A hash of that
diagnosis determines its version and run id. The id is claimed transactionally
in `agentRuns/`, preventing duplicate calls if the listener replays the same
incident or it changes without a new diagnosis version.

For a claimed run, the service loads each event id from `networkEvents/`, then
follows each non-null `sourceLogId` to the original `networkLogs/` document.
The prompt contains the deterministic baseline, incident summary, normalized
events, and raw device logs. It tells the model to treat evidence as data, not
instructions, and to cite only supplied event and log ids.

### Model investigation and validation

The prompt is sent to the configured model through the OpenAI Responses API,
requesting strict structured JSON and no tools. The model returns its own
root-cause category, affected devices, summary, confidence, reasoning, and
evidence citations. The service validates the response and verifies that every
cited event or log id was actually supplied; missing or invented citations
fail validation.

Agreement is calculated by the service, not trusted from model output: it
compares the model's cause and devices with the deterministic baseline. A
successful run records the conclusion, agreement, evidence citations, response
metadata, token usage, latency, and estimated cost.

### Output, failures, and safety boundary

The Agent Service writes only to `agentRuns/`. Each run records its lifecycle:
`collecting_evidence` → `analyzing` → `completed`, or `failed`. Evidence-loading,
API, output-validation, and persistence errors are isolated to that
investigation; when a run has been claimed, its failure is recorded rather than
propagated into the Health, Layer 0, or Incident services.

This investigator has no Docker, SSH, `vtysh`, controller, or action tools. It
can analyze and report, but cannot remediate or otherwise change the network.

## Next planned stage: controlled network actions

**Planned only — Increment 5 is not implemented, and the Network Controller
directory is a placeholder.** The diagram below is a high-level target flow
from the project specification, not a description of running code. The action
contract and risk/approval boundary must be designed before this flow is
connected to the Agent Service. The current Agent Service remains read-only.

```mermaid
flowchart TD
  A[("Current inputs:<br/>incidents/ + agentRuns/<br/>diagnosis and evidence")]
  B["Future: propose a bounded action<br/>for a diagnosed incident"]
  C["Describe target, expected effect,<br/>risk and verification plan"]
  D[("Planned: agentActions/<br/>action proposal + lifecycle")]
  E["Future risk and authorization policy<br/>(Increment 6 boundary)"]
  F{"Policy permits action?"}
  G["Update proposal as rejected/held"]
  H{"Operator approval required?"}
  I["Wait for authorized approval"]
  J{"Approved?"}
  K["Update proposal as rejected/expired"]
  L["Controlled Network Controller<br/>validate action contract and target"]
  M{"Request valid and allowed?"}
  N["Reject request;<br/>record reason on proposal"]
  O["Apply bounded action"]
  P["Observe network and verify<br/>expected effect"]
  Q{"Successful?"}
  R["Record success;<br/>close action lifecycle"]
  S["Rollback if available and verify;<br/>otherwise escalate"]
  T[("Planned: networkChanges/<br/>before/after + result + audit")]
  U(["Stop: no network change"])

  A -. "future connection only" .-> B
  B --> C --> D --> E --> F
  F -- "No" --> G --> U
  F -- "Yes" --> H
  H -- "Yes" --> I --> J
  J -- "No" --> K --> U
  J -- "Yes" --> L
  H -- "No" --> L
  L --> M
  M -- "No" --> N --> U
  M -- "Yes" --> O --> P --> Q
  Q -- "Yes" --> R --> T
  Q -- "No" --> S --> T
```

At a high level, a future proposal would be bounded and explain its target,
expected effect, risk, and verification plan. A separate policy boundary must
decide whether the action is permitted and whether an authorized operator must
approve it. Only then could a Network Controller validate and apply the
approved action. ACN would observe the result and record success, rollback, or
escalation for audit. Rejected, held, or invalid requests would be recorded
without changing the network.

The planned data model names `agentActions/` for proposals and
`networkChanges/` for execution results. Their exact schemas, risk levels,
authorization rules, action catalog, verification and rollback behavior are
not yet implemented; the diagram intentionally does not define those details.
The manual Lab Controller remains a separate, local demo tool and is not this
future action path.

## Implementation references

- Layer 0 log collection and pipeline:
  [`services/layer-zero/src/pipeline.ts`](../services/layer-zero/src/pipeline.ts)
- Layer 0 FRR parsing:
  [`services/layer-zero/src/normalize/parser.ts`](../services/layer-zero/src/normalize/parser.ts)
- Layer 0 FRR event rules:
  [`services/layer-zero/src/normalize/rules.ts`](../services/layer-zero/src/normalize/rules.ts)
- Layer 0 router-state observer:
  [`services/layer-zero/src/observer/stateObserver.ts`](../services/layer-zero/src/observer/stateObserver.ts)
- Health Service pipeline:
  [`services/health-service/src/service.ts`](../services/health-service/src/service.ts)
- Health check and ping classification:
  [`services/health-service/src/checks/healthCheck.ts`](../services/health-service/src/checks/healthCheck.ts),
  [`services/health-service/src/checks/ping.ts`](../services/health-service/src/checks/ping.ts)
- Health state transitions:
  [`services/health-service/src/checks/stateTracker.ts`](../services/health-service/src/checks/stateTracker.ts)
- Incident Service lifecycle:
  [`services/incident-service/src/service.ts`](../services/incident-service/src/service.ts)
- Incident correlation and lifecycle:
  [`services/incident-service/src/correlation/correlator.ts`](../services/incident-service/src/correlation/correlator.ts)
- Incident root-cause inference:
  [`services/incident-service/src/correlation/rootCause.ts`](../services/incident-service/src/correlation/rootCause.ts)
- Agent Service lifecycle:
  [`services/agent-service/src/service.ts`](../services/agent-service/src/service.ts)
- Agent evidence loading and run persistence:
  [`services/agent-service/src/firebase/repository.ts`](../services/agent-service/src/firebase/repository.ts)
- Agent prompt and model client:
  [`services/agent-service/src/investigation/prompt.ts`](../services/agent-service/src/investigation/prompt.ts),
  [`services/agent-service/src/openai/client.ts`](../services/agent-service/src/openai/client.ts)
- Planned next increment and architecture:
  [`services/network-controller/README.md`](../services/network-controller/README.md),
  [`architecture.md`](./architecture.md),
  [`data-model.md`](./data-model.md),
  [`ACN_FUNCTIONAL_TECHNICAL_SPECIFICATION.md`](../ACN_FUNCTIONAL_TECHNICAL_SPECIFICATION.md)
