# ACN Data Pipeline

This guide follows ACN's telemetry and investigation data pipeline: how
observations of the network move from source through ingestion, storage, and
processing to the services and operators that consume them. It is distinct
from the network data plane, which is the routed path ACN monitors. GPT
investigates and may produce an inert typed repair proposal; actual repair is a
separate guarded control flow that requires human approval.

## ACN telemetry and investigation pipeline

```mermaid
flowchart LR
  Sources["Network sources<br/>FRR logs, router state, ICMP targets"]
  Ingest["Ingestion<br/>Layer 0 collectors + Health Service"]
  Raw[("networkLogs/<br/>raw evidence")]
  Checks[("healthChecks/<br/>every probe round")]
  Events[("networkEvents/<br/>state transitions")]
  Process["Incident Service<br/>correlate, diagnose, track recovery"]
  Incidents[("incidents/<br/>current incident state")]
  Agent["Agent Service<br/>neutral evidence + investigation"]
  Runs[("agentRuns/<br/>conclusion + optional proposal")]
  Evaluate[("labEvaluations/<br/>hidden lab truth")]
  Controller["Network Controller<br/>approval + fixed repair"]
  Actions[("agentActions/<br/>actionAuditEvents/<br/>networkChanges/")]
  Serve["Serving<br/>read-only NOC dashboard"]

  Sources --> Ingest
  Ingest --> Raw
  Ingest --> Checks
  Ingest --> Events
  Raw -.->|"sourceLogId"| Events
  Events --> Process --> Incidents
  Incidents --> Agent
  Events -.->|"eventIds"| Agent
  Raw -.->|"sourceLogId"| Agent
  Agent --> Runs
  Evaluate -.->|"claim at run start; reveal after valid response"| Agent
  Runs -.->|"optional inert proposal"| Controller
  Controller --> Actions
  Checks --> Serve
  Raw --> Serve
  Events --> Serve
  Incidents --> Serve
  Runs --> Serve
  Evaluate --> Serve
  Actions --> Serve
```

## 1. Source: where observations originate

The lab exposes three kinds of observations:

| Source | What it observes | Example |
| --- | --- | --- |
| FRR daemon logs | Messages produced by zebra and ospfd when interfaces or OSPF adjacencies change | R2 reports its OSPF neighbor on `eth2` leaving `Full` |
| Router state | A read-only probe checks intended R2/R3 settings, ospfd process state, and R3's CPU quota | R3's ospfd is stopped while its CPU quota is constrained |
| Reachability targets | The Health Service pings router loopbacks and host data-plane IPs | R3 loopback `10.255.0.3` and PC2 `10.0.3.2` stop replying |

Health checks intentionally target data-plane addresses rather than management
addresses. Management connectivity can remain healthy while the emulated
network is broken, which would hide the fault being monitored.

## 2. Ingestion: how observations enter the system

The Health Service and Layer 0 are separate collectors with different jobs.
They do not wait on one another.

### Health Service

1. Loads the configured device list and upserts its records to `devices/` on
   startup.
2. Periodically pings each enabled device's data-plane `checkAddress`.
3. Produces one health result per device per round.
4. Uses a state tracker to emit a network event only when a device changes
   between healthy and down. Its first observation establishes a baseline and
   does not create a synthetic transition.

### Layer 0

1. Tails the FRR daemon log files mounted from the router containers.
2. Independently polls router state using Docker probes; fault and recovery
   transitions from these probes are fed through the same Layer 0 processing
   path.
3. Parses the FRR log envelope, then applies normalization rules to recognize
   meaningful events. Parsing extracts structure; normalization assigns event
   meaning. Routine messages and intermediate OSPF states can produce no event.
4. Buffers observations and writes them in batches, rather than issuing a
   Firestore request for every line.

Every FRR line is retained, including unparsed lines and parsed lines that do
not represent an event. This makes raw device output available when parser or
normalizer rules need improvement.

## 3. Storage: what is persisted

All implemented collections are in Firestore. Backend services use the Admin
SDK; the dashboard uses read-only access.

| Collection | Written by | What each document represents |
| --- | --- | --- |
| `devices/` | Health Service | Current configured device metadata, keyed by device id |
| `healthChecks/` | Health Service | One result per device per polling round; append-only |
| `networkLogs/` | Layer 0 | Every collected FRR line and the probe output accompanying each detected state transition |
| `networkEvents/` | Health Service and Layer 0 | Recognized state transitions from either source |
| `incidents/` | Incident Service | Current lifecycle and diagnosis for a correlated fault, updated in place |
| `agentRuns/` | Agent Service | One investigation lifecycle and result per deterministic diagnosis version |
| `labEvaluations/` | Lab Controller and Agent Service | Opaque expected lab outcome, atomically associated with one run and revealed/scored only after a valid conclusion |
| `labActions/` | Lab Controller | Operator-triggered scenario status and recent script output |
| `agentActions/` | Agent Service and Network Controller | Inert typed repair proposal and its guarded lifecycle |
| `actionAuditEvents/` | Network Controller | Append-only proposal, approval, execution, and verification transitions |
| `networkChanges/` | Network Controller | Bounded before/after state, transport result, and observer-backed verification |

`networkLogs/` retains the original text in `raw`. Parsed fields are stored
alongside it when available, with `parsed` and `normalized` flags showing how
far processing got. Device event time and collector/server receive time are
both kept where applicable; they answer different timing questions.

For Layer 0 events, `sourceLogId` points to the exact `networkLogs/` document.
The raw log and derived event are written in the same Firestore batch, so the
reference cannot point to a missing log. Health Service ICMP events have
`sourceLogId: null` because no log line produced them.

## 4. Processing: how observations become incidents and investigations

### Event production

`networkEvents/` is the shared stream, not a copy of every raw observation:

- Health Service stores every check in `healthChecks/`, but emits
  `device_unreachable` or `device_recovered` only on a reachability transition.
- Layer 0 stores every input in `networkLogs/`, but emits a `networkEvent`
  only when a normalization rule or state observer recognizes a transition.

Events carry their device, type, severity, attributes, source, and occurrence
time. Their common collection lets later processing correlate symptoms and
router-level evidence.

### Incident correlation

The Incident Service watches new `networkEvents/` documents. It groups related
events within its correlation and settle windows, applies deterministic
root-cause rules, and records the event ids used. The diagnosis includes both
its predicted impact and the independently observed unreachable devices, so a
mismatch stays visible. Recovery updates or resolves the incident according to
the kind of fault; persistent configuration, service, and resource faults
require the state observer's recovery transition.

An incident is updated in place in `incidents/`. It is therefore the current
incident state, while the linked event and log documents preserve the evidence
trail.

### AI investigation

The Agent Service watches settled incident evidence revisions. For a new
revision and prompt contract it:

1. Claims a deterministic run id to avoid duplicate investigations on listener
   replays or service restarts.
2. Loads the incident's `eventIds` and follows each `sourceLogId` to raw logs.
3. Projects neutral facts and raw logs into a prompt; it excludes deterministic
   diagnosis, incident symptoms, cause-revealing event names, scenario labels,
   and controller output.
4. Sends the evidence to the configured model through the OpenAI Responses API
   and validates the structured conclusion and every cited evidence id.
5. Only after committing a valid cited conclusion, loads any associated
   controller-created lab ground truth and scores cause/device matches. Runs
   without lab truth remain explicitly unscored.
6. Persists lifecycle, conclusion, optional inert repair proposal, evaluation,
   citations, usage, latency, and estimated cost in `agentRuns/`.

The Agent Service has no Docker, SSH, `vtysh`, or controller execution
capability. A typed proposal is not authority to change the network.

## 5. Serving: who reads the data

The Angular NOC dashboard subscribes to the emulator's Firestore data and
combines recent checks, logs, events, incidents, agent runs, lab evaluations,
action audits, network changes, and lab actions into the operator view. Browser
Firestore writes are denied; approval decisions are sent to the
localhost-only Network Controller.

Manual fault buttons use a separate path. The browser sends one of a fixed set
of named requests to the localhost-only Lab Controller. The controller runs
the corresponding repository-owned scenario script and writes its lifecycle
and output to `labActions/`. This is an operator demo control, separate from AI remediation.

For guarded repairs, the Network Controller watches completed agent runs,
revalidates proposals and cited evidence, and stores a deterministic
`agentActions/` record. Every mutating action requires explicit human approval.
It uses only a fixed catalog and code-owned, shell-free arguments; preflight
checks the incident and target state. `networkChanges/` records bounded
execution details, and an action succeeds only after fresh observer recovery
evidence and incident resolution. Every lifecycle transition is recorded in
`actionAuditEvents/`. The controller binds to loopback port 8788; it is not the
Lab Controller and it is not a general network command interface.

## Example: R2-R3 link failure

1. R2 and R3 write interface/OSPF changes to their FRR logs. Layer 0 tails the
   lines, stores them in `networkLogs/`, and emits normalized events linked by
   `sourceLogId`.
2. On its next polling round, the Health Service finds R3 and PC2 unreachable.
   It writes their results to `healthChecks/` and emits device transition
   events to `networkEvents/`.
3. The Incident Service sees both device symptoms and router-side events,
   correlates them, and writes a link diagnosis with evidence and predicted
   impact to `incidents/`.
4. The Agent Service builds a neutral evidence prompt from observations and
   raw logs, excluding the deterministic diagnosis and lab truth. It records
   its independently cited conclusion in `agentRuns/`; controller-triggered
   runs are scored against hidden ground truth only afterward.
5. If GPT returns a typed repair proposal, it remains inert until revalidated
   and approved by a human through the Network Controller. A fixed adapter runs
   and the observer verifies recovery before success is recorded.
6. The dashboard shows the incident, evidence, GPT evaluation, repair proposal,
   human decision, audit trail, and result. Fault injection/restoration remains
   a separate Lab Controller operation.

## Boundaries to keep in mind

- Raw observations, normalized events, incidents, and AI runs are different
  layers of data; a later layer does not replace its evidence.
- Layer 0 emits events but does not decide what constitutes an incident.
- Incident diagnosis is deterministic and does not depend on the AI result.
- The AI investigates and can propose; only the separately guarded Network
  Controller can execute a human-approved, allow-listed repair.
- The local Lab Controller is separate from the telemetry and investigation
  pipeline and is restricted to fixed manual scenarios.
