# ACN local lab controller

Localhost-only control plane for the operator visualizer. It exposes five
fault-injection actions and one restore action:

- introduce configuration drift
- break the R2–R3 OSPF session
- disable the R2–R3 interface
- stop R3's OSPF daemon
- exhaust R3 control-plane CPU
- restore the network

The API never accepts a command, executable, path, device name or interface
from the browser. Each route maps to one repository-owned scenario script, only
one action may run at a time, and status plus the last 100 output lines are
written to `labActions/` for the live dashboard.

Restore removes injected faults, then waits for R2, R3 and PC2 to become
reachable, allowing up to 90 seconds for OSPF convergence. Each controller
scenario is also limited to 120 seconds; a timeout terminates its process
group, records a failed action, and releases the controls. If containerlab
interfaces or host routes are missing (for example after a host reboot),
restore reports that explicitly; run
`./lab/deploy.sh --reconfigure` from a terminal to recreate the lab links and
routes.

```bash
npm run lab-controller   # http://127.0.0.1:8787
```

This is a manual, synthetic-lab demonstration harness. It is separate from the
GPT Agent Service and does not give Luna an action tool. It is not the planned
Increment 5 Network Controller or the Increment 6 approval policy.
