# ACN local lab controller

Localhost-only control plane for the operator visualizer. It exposes exactly
three actions:

- break the R2–R3 link
- stop the R3 router
- restore the network

The API never accepts a command, executable, path, device name or interface
from the browser. Each route maps to one repository-owned scenario script, only
one action may run at a time, and status plus the last 100 output lines are
written to `labActions/` for the live dashboard.

```bash
npm run lab-controller   # http://127.0.0.1:8787
```

This is a manual, synthetic-lab demonstration harness. It is separate from the
GPT Agent Service and does not give Luna an action tool. It is not the planned
Increment 5 Network Controller or the Increment 6 approval policy.
