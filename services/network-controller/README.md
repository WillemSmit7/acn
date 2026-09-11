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
