# Controlled, audited network actions

**Increment 6 — guarded remediation boundary.**

This service will be the only component allowed to mutate network state. GPT
submits a typed repair proposal; a human chooses whether to run it, and the
harness executes a fixed code-owned adapter and
waits for autonomous recovery evidence before reporting success.

It does not validate or overrule GPT's diagnosis or repair guess. Lab accuracy
is the direct GPT-versus-hidden-ground-truth comparison from Increment 5,
extended to the chosen repair. The repair outcome is separate: the watcher
either sees the incident recover after the approved action or it does not.

It will never expose arbitrary shell, Docker, SSH, PID, file path, executable,
device or interface arguments to the model. The Lab Controller remains a
separate fault-injection-only service.

See [../../docs/increment-6-plan.md](../../docs/increment-6-plan.md) for the
approved tool catalog, lifecycle, data model and exit criteria.

`FirestoreActionRepository` validates a completed agent run and cited conclusion
before transactionally creating `agentActions` and one proposal audit. The
loopback API records a named approval before a fixed adapter can run its
catalog-owned argv. `networkChanges` captures bounded before/after
state and transport outcome; only fresh autonomous recovery plus incident
resolution can mark success. The dashboard exposes the proposal and decision
timeline without receiving Firestore write access.

All five mutating catalog tools have separately reviewed preconditions,
postconditions, fixed argument arrays and autonomous recovery events.

The R3 adapters use code-owned, BusyBox-compatible recovery scripts. Resource
restoration first returns the container to the explicit one-CPU baseline, then
signals only marker PIDs whose current process name is still `yes`, resumes the
FRR watchdog, and restarts FRR only when `ospfd` remains absent. Preconditions
accept owned partial-repair states so a failed cleanup can be retried, while the
routing-service-only adapter still rejects an active CPU/resource fault. Failed
changes record the exact fixed step, exit code and timeout state.
