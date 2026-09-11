# Controlled, audited network actions

**Increment 6 — guarded remediation boundary.**

This service will be the only component allowed to mutate network state. GPT
submits a typed repair proposal; the controller validates it, requires human
approval, checks live preconditions, executes a fixed code-owned adapter and
waits for autonomous recovery evidence before reporting success.

It will never expose arbitrary shell, Docker, SSH, PID, file path, executable,
device or interface arguments to the model. The Lab Controller remains a
separate fault-injection-only service.

See [../../docs/increment-6-plan.md](../../docs/increment-6-plan.md) for the
approved tool catalog, lifecycle, data model and exit criteria.
