# ACN Architecture

## Layered responsibilities

Each component has exactly one job. Nothing skips a layer.

```
NETWORK
   |
   v
HEALTH / DATA COLLECTION      <-- Increment 1 (built)
   |
   v
LAYER 0  (normalization)      <-- Increment 2 (built)
   |
   v
INCIDENT DETECTION            <-- Increment 3
   |
   v
AI AGENT                      <-- Increment 4 (read-only), 5 (actions)
   |
   v
CONTROLLED NETWORK ACTIONS    <-- Increment 5, gated by risk policy in 6
   |
   v
AUDIT + VERIFICATION
```

## What exists today (Increments 1-2)

```
+------------------------------------------------------------------+
|                          Ubuntu Host                             |
|                                                                  |
|  +--------------------------+                                    |
|  |       Containerlab       |                                    |
|  |                          |                                    |
|  |  PC1--R1--R2--R3--PC2    |   FRRouting 10.2 + OSPF area 0     |
|  +------------+-------------+                                    |
|               |                                                  |
|               |  host routes: 10.255.0.0/24, 10.0.0.0/16 via r1  |
|               |  FRR logs: lab/logs/<router> -> /var/log/frr     |
|               v                                                  |
|  +--------------------------+  +----------------------------+    |
|  |      Health Service      |  |          Layer 0           |    |
|  |                          |  |                            |    |
|  |  - ICMP checks every 30s |  |  - docker exec tail -F     |    |
|  |  - state transition      |  |  - parse -> normalize      |    |
|  |    detection             |  |  - raw line + event        |    |
|  +------------+-------------+  +-------------+--------------+    |
|               |                              |                   |
|               |  ICMP transitions            |  log-derived      |
|               v                              v                   |
|  +--------------------------------------------------------+      |
|  |         Firebase Emulator Suite - Firestore            |      |
|  |                                                        |      |
|  |  devices/  healthChecks/  networkLogs/  networkEvents/ |      |
|  +--------------------------------------------------------+      |
+------------------------------------------------------------------+
```

Both services write into `networkEvents/`, distinguished by `source`. That is
deliberate: Increment 3 correlates a device going unreachable (ICMP) with the
interface and adjacency events the routers logged at the same moment, and it
can only do that if both are in one stream on a common `deviceId`.

## Why the Health Service pings loopbacks, not management addresses

This is the single most important design decision in Increment 1.

Containerlab gives every node a management interface on `172.20.20.0/24`.
That interface stays up even when the emulated data plane is completely
broken. If the Health Service pinged management addresses, shutting the
R2-R3 link would change nothing observable — the demo would silently prove
nothing.

So each router carries a loopback (`10.255.0.1-3/32`) advertised into OSPF,
and hosts are checked on their data-plane addresses. Those are reachable
**only through the emulated network**. `lab/deploy.sh` adds two host routes
pointing at R1's management address, giving the Health Service process a way
into the data plane:

```
sudo ip route replace 10.255.0.0/24 via 172.20.20.11
sudo ip route replace 10.0.0.0/16   via 172.20.20.11
```

Break R2 eth2 and R2's loopback stays reachable (host -> R1 -> R2) while R3
and PC2 go dark — exactly the symptom set Increment 3's correlation logic will
need to reason about.

Management addresses are retained in `devices/` because later increments need
them for `vtysh` / `docker exec` access from the Network Controller.

## Why ICMP is done by shelling out to `ping`

Raw ICMP sockets require `CAP_NET_RAW`. Ubuntu's `/bin/ping` already carries
that capability, so spawning it lets the Health Service run as an unprivileged
user with no native dependencies and no setcap step. Exit codes are
distinguished carefully: exit 1 means "device did not reply" (a genuine
outage), anything else means "the check itself failed" (recorded with a
`check failed:` reason so operational gaps are never mistaken for outages).

## Failure isolation

Security rule 8 — an AI or database failure must not take down monitoring — is
enforced structurally:

- `checkDevice` never throws; an unexpected error becomes a `down` result.
- `HealthService.persist` catches Firestore errors per collection, so a
  database outage loses writes but never stops the loop.
- `HealthService.tick` has a final catch, so no round can kill the timer.
- Overlapping rounds are skipped, never queued, so a slow network cannot
  cause unbounded concurrency.

## Why Layer 0 reads log files through Docker

The obvious designs do not work against real FRR, and each was tried:

**`docker logs` goes silent.** FRR daemonizes. Once watchfrr forks the daemons,
their output no longer reaches the container's stdout, so the container log
contains startup chatter and nothing else. A link failure leaves no trace in it.

**`log file` in `frr.conf` does not reach ospfd.** ospfd (and staticd) reject
the runtime `log file` command for any path, including world-writable ones,
while zebra and mgmtd accept it. Configured that way, OSPF adjacency changes
never reach disk — and nothing reports an error, because ospfd stays up. The
destinations are therefore set as `--log file:` startup flags in
`lab/configs/daemons`, one file per daemon.

**`/var/run/frr` is not writable by the daemons that matter.** zebra opens its
log while still root; ospfd opens its own only after dropping to the `frr` user
and then silently fails. Each router bind-mounts `lab/logs/<router>/` at
`/var/log/frr`, created mode 777 by `deploy.sh`, so both daemons can write
regardless of when they drop privileges.

**The resulting files are root-owned mode 600 on the host**, so reading them
host-side would need root. Collection goes back through `docker exec … tail -F`,
which can read them.

The lesson worth carrying forward is that every one of these failures was
silent. The daemon stayed up, the config looked right, and the events simply
were not there. Increment 2's log pipeline is verified against a real link
failure for exactly that reason.

## Deferred deliberately

No message bus, no Neo4j, no BigQuery, no Cloud Functions, no Angular app, no
Claude integration. Each arrives in the increment that needs it.

Layer 0 also has no incident concept: it emits events and stops there. Deciding
that an `interface_down` on r2 and a `device_unreachable` for r3 and pc2 are one
incident is Increment 3's job, and putting that inference in the normalizer
would make it impossible to change later without re-parsing history.
