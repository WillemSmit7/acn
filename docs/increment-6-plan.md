# Increment 6 — guarded AI remediation

## Goal

Allow GPT to propose a narrowly typed repair for a diagnosed incident and let a
separate Network Controller execute it only after policy validation and explicit
human approval. The model never receives shell, Docker, SSH, PID, path, or
free-form command access.

## Safety boundary

The investigator remains evidence-driven. Its structured result may contain at
most one remediation proposal. A proposal is data, not authority to execute.

Only `services/network-controller` may mutate the network. It independently:

1. validates the exact tool and closed argument schema;
2. checks that the cited incident is still open and the diagnosis run completed;
3. reads the current device state and enforces the tool precondition;
4. requires a distinct human approval for every mutation in Increment 6;
5. maps the typed request to fixed `execFile` argument arrays owned by code;
6. waits for fresh autonomous-observer recovery and incident resolution;
7. records every transition and network change; and
8. fails closed or escalates when any guard or verification fails.

The Lab Controller stays fault-injection-only and is never used as the AI action
path.

## Initial tool catalog

The first catalog is deliberately repair-only and fixed to the current lab:

| GPT-visible repair intent | Fixed target | Required precondition | Verified outcome | Risk |
|---|---|---|---|---|
| `restore_ospf_cost` | R2 `eth2` | OSPF cost differs from intended 10 | intended cost observed; incident resolves | medium |
| `restore_ospf_adjacency` | R2 `eth2` | interface is passive while administratively up | passive removed; neighbor recovers; incident resolves | medium |
| `enable_interface` | R2 `eth2` | administratively down | admin up; neighbor/reachability recover; incident resolves | high |
| `restart_routing_service` | R3 `ospfd` | service absent and container alive | process and neighbor recover; incident resolves | high |
| `restore_resource_profile` | R3 | bounded lab CPU profile or owned stress markers present | quota/process baseline and incident recovery observed | high |
| `escalate_no_safe_action` | none | evidence is insufficient or no tool fits | no mutation; operator escalation recorded | none |

There is no general `run_command`, `configure_device`, `set_value`, arbitrary
target, or multi-action batch tool.

## Action lifecycle

`agentActions/{actionId}` is the current state; `actionAuditEvents/` is the
append-only history.

```text
proposed -> approved -> executing -> verifying -> succeeded
        \-> rejected
                    \-> failed -> escalated
```

Each proposal has a deterministic idempotency key derived from incident, agent
run and canonical tool call. A repeated or concurrent request returns the same
record and can never execute twice.

Approval captures the approver, time, incident version and precondition digest.
Execution rejects stale approvals when the incident resolved, evidence changed,
or current device state no longer matches the approved precondition.

Rollback is not claimed automatically for simple repairs because restoring a
faulty pre-state would recreate the outage. A tool may expose a guarded
compensating operation only when it captured a healthy pre-state and can prove
that its own partial change caused a new regression. Otherwise failure is
escalated for an operator.

## Data records

- `agentActions/`: immutable proposal identity, incident/run references, tool,
  fixed target, cited evidence, rationale, risk, approval, lifecycle, guard
  results, verification references and safe error.
- `actionAuditEvents/`: append-only transition, actor (`ai`, `human`, `policy`,
  `controller`, `observer`), reason and server timestamp.
- `networkChanges/`: action reference, typed operation, before/after snapshots,
  transport result, observer verification and compensation metadata. No
  credentials or model-supplied command strings are stored.

Browser writes remain denied by Firestore. The dashboard calls a localhost-only
Network Controller approval endpoint, which applies server-side transitions.

## Implementation order

1. Define the discriminated tool union, strict validator, risk policy and action
   state machine with rejection tests.
2. Implement proposal persistence and append-only audit events with transactional
   idempotency and stale-incident checks.
3. Add GPT's optional single repair proposal to the strict structured output and
   submit it to the controller only after citation validation and diagnosis
   completion.
4. Build the first vertical slice, `enable_interface`, using fixed Docker/vtysh
   arguments, read-only preflight and observer-backed verification.
5. Add the dashboard approval/rejection card and live action timeline.
6. Exercise success, rejection, duplicate, invalid-target, missing-approval,
   precondition mismatch, stale incident, execution timeout and verification
   failure end to end.
7. Add the remaining four repair adapters one at a time, each with its own
   precondition and recovery test.

## Exit criteria

- Fuzzed or malicious model arguments cannot reach a process invocation.
- No mutating action executes without a recorded human approval.
- Concurrent/replayed proposals and approvals execute at most once.
- A command exit code alone can never mark an action successful.
- Success requires fresh watcher evidence and incident resolution.
- Every state transition and network mutation is auditable.
- Monitoring, correlation and diagnosis continue when the controller fails.
- The healthy baseline and all 111 existing tests remain green.

## Deferred

- Automatic approval, even for low-risk actions.
- Arbitrary devices, interfaces, services, vendors or command execution.
- Multi-action plans and simultaneous-fault remediation.
- Production authentication/RBAC, durable queues and distributed controller
  leadership.
