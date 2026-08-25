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
LAYER 0  (normalization)      <-- Increment 2
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

## What exists today (Increment 1)

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
|               v                                                  |
|  +--------------------------+                                    |
|  |      Health Service      |   Node.js + TypeScript             |
|  |                          |                                    |
|  |  - ICMP checks every 30s |                                    |
|  |  - state transition      |                                    |
|  |    detection             |                                    |
|  +------------+-------------+                                    |
|               |                                                  |
|               v                                                  |
|  +--------------------------+                                    |
|  |  Firebase Emulator Suite |   devices/                         |
|  |         Firestore        |   healthChecks/                    |
|  |                          |   networkEvents/                   |
|  +--------------------------+                                    |
+------------------------------------------------------------------+
```

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

## Deferred deliberately

No message bus, no Neo4j, no BigQuery, no Cloud Functions, no Angular app, no
Claude integration. Each arrives in the increment that needs it.
