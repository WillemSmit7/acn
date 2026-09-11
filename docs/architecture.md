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
INCIDENT DETECTION            <-- Increment 3 (built)
   |
   v
AI AGENT                      <-- Increment 4 (read-only, built), 5 (actions)
   |
   v
CONTROLLED NETWORK ACTIONS    <-- Increment 5, gated by risk policy in 6
   |
   v
AUDIT + VERIFICATION
```

## What exists today (Increments 1-4)

```
+------------------------------------------------------------------+
|                          Ubuntu Host                             |
|                                                                  |
|  +--------------------------+                                    |
|  |       Containerlab       |                                    |
|  |  PC1--R1--R2--R3--PC2    |   FRRouting 10.2 + OSPF area 0     |
|  +------------+-------------+                                    |
|               |  host routes via r1 | FRR logs bind-mounted      |
|               v                                                  |
|  +--------------------------+  +----------------------------+    |
|  |      Health Service      |  |          Layer 0           |    |
|  |  ICMP every 30s          |  |  FRR tails + state probes  |    |
|  |  state transitions       |  |  transitions -> normalize |    |
|  +------------+-------------+  +-------------+--------------+    |
|               |  ICMP transitions           | evidence-derived   |
|               v                             v                    |
|  +--------------------------------------------------------+      |
|  |         Firebase Emulator Suite - Firestore            |      |
|  | devices/ healthChecks/ networkLogs/ networkEvents/     |      |
|  | incidents/ agentRuns/ labActions/                      |      |
|  +---------------+--------------------------+-------------+      |
|                  |  watches networkEvents   |  reads             |
|                  v                          v                    |
|  +--------------------------+   +---------------------------+    |
|  |     Incident Service     |   |    NOC dashboard (web)    |    |
|  |  correlate -> incidents/ |   |  Angular, read-only, live |    |
|  +------------+-------------+   +---------------------------+    |
|               | reads incident + evidence                         |
|               v                                                   |
|  +--------------------------+                                     |
|  |       Agent Service      |  GPT-5.6 Luna, low reasoning       |
|  |  read-only -> agentRuns/ |  no network/action capability      |
|  +--------------------------+                                     |
|                                                                  |
|  Browser --named action--> Lab Controller --fixed script--> Lab  |
|             127.0.0.1 only; output -> labActions/                |
+------------------------------------------------------------------+
```

The Health Service and Layer 0 both write into `networkEvents/`, distinguished
by `source`. That is what makes Increment 3 possible: the Incident Service
correlates a device going unreachable (ICMP) with the interface and adjacency
events the routers logged at the same moment, which it can only do because both
are in one stream on a common `deviceId`.

The dashboard never writes Firestore. Every database write comes from a backend
service using the Admin SDK. Its manual demo buttons call the separate local
Lab Controller, not the Agent Service.

The Agent Service watches settled diagnoses, follows `eventIds` into
`networkEvents/` and `sourceLogId` into the untouched `networkLogs/` text, then
calls the OpenAI Responses API with `gpt-5.6-luna`. Its only write is the
investigation record in `agentRuns/`. It owns no Docker, SSH, `vtysh`, network
controller or remediation interface, so the Increment 4 read-only boundary is
structural rather than merely a prompt instruction.

The Lab Controller is deliberately outside that path. It binds to
`127.0.0.1`, exposes only six named routes, maps them to repository-owned lab
scenario scripts and records lifecycle/output in `labActions/`. It accepts no
command, path, device or interface parameters and refuses overlapping actions.
This gives a human an interactive demo harness without giving GPT an action
tool. It is not the general Network Controller planned for Increment 5 and has
no production authority model.

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
- The Agent Service is a separate process above incident detection. API or
  Firestore failures are caught per run and written as `status: failed` where
  possible; they cannot propagate into the three monitoring services.
- Investigations run one at a time and use deterministic run ids, preventing
  event bursts or listener replays from multiplying paid API calls.

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

## Why correlation is deterministic

Increment 3 uses explicit rules, not an LLM. GPT-5.6 Luna appears only in
Increment 4, after the incident already exists. An inference nobody can
reproduce is not a baseline to improve on.

The rules turn on one question — did the far end of the link corroborate? — and
every conclusion records its evidence in plain language plus a check of what it
predicted against what was observed. See `docs/incident-model.md`.

The hard lesson from building it: **do not resolve incidents by matching each
fault to a recovery.** FRR log timestamps have one-second resolution, so an
interface down/up pair inside the same second arrives in arbitrary order; seen
"up" first, the trailing "down" re-opens a fault nothing ever clears. Recovery
events also go missing when the collector reattaches its tail during a redeploy.
Connectivity-fault resolution follows observed reachability because the Health
Service re-checks it every round. Persistent configuration, session, admin,
service, and resource faults instead require the autonomous state observer's
matching recovery transition; ICMP health cannot close them.

## The UI, and why the emulator is not a limitation

The NOC dashboard (`apps/web`) is pulled forward from Increment 7 deliberately:
a correlation engine you cannot watch working is hard to trust. Its Firestore
connection remains read-only; the only controls are local synthetic-lab
scenarios routed through the narrow Lab Controller described above.

It connects to the Firestore **emulator** with the ordinary Firebase JS SDK -
same queries, same live `onSnapshot` listeners it would use against a real
project. So no real Firebase project is needed to run a browser UI, and nothing
about the UI changes when one arrives in Increment 10. The repo stays free of
credentials and `./scripts/reset-firestore.sh` keeps working.

The one thing that did have to change is `firebase/firestore.rules`, which
denied all client access. Reads are now open for the seven collections the
dashboard renders; writes stay denied everywhere, as do reads of the
collections later increments add. That is safe only against a local emulator
holding synthetic data — see the warning in the rules file.

The Increment 5 view shows `collecting evidence` and `analyzing` stages live.
GPT receives neutral observations and raw logs without the deterministic
diagnosis, scenario label or incident symptoms. For controller-triggered lab
runs, the completed view then reveals hidden lab ground truth beside GPT's
committed conclusion and scores cause type and device set separately. Direct
script and production-style runs remain explicitly unscored.

The operator timeline merges recent health probes, raw FRR lines, normalized
events, incident state, lab action output and agent state by timestamp. This is
computed in the browser from existing source-of-truth collections; it does not
duplicate telemetry into a second activity collection.

## Deferred deliberately

No message bus, Neo4j, BigQuery, Cloud Functions, network action interface or
risk-policy infrastructure exists yet. Each arrives only in the increment that
needs it.

Layer 0 also has no incident concept: it emits events and stops there. Deciding
that an `interface_down` on r2 and a `device_unreachable` for r3 and pc2 are one
incident is Increment 3's job, and putting that inference in the normalizer
would make it impossible to change later without re-parsing history.
