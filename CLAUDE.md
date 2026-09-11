# ACN — AI-Centered Network

Network-operations environment: collect network data, normalize it, store it,
and eventually let an AI agent investigate and remediate. Built incrementally,
with `PROGRESS.md` as the authoritative status and scope record.

**Read `PROGRESS.md` first** — it is the authoritative status record. This file
holds the durable context and the traps that cost real time.

---

## Current state: Increments 1–4 complete; operator visualizer implemented

All four end-to-end tests pass against the real lab, including two live
GPT-5.6 Luna investigations:

```bash
./scripts/e2e-test.sh         # Increment 1 - ICMP -> Firestore, 8 assertions
./scripts/e2e-layer-zero.sh   # Increment 2 - FRR logs -> events, 16 assertions
./scripts/e2e-incidents.sh    # Increment 3 - events -> incidents, 16 assertions
./scripts/e2e-agent.sh        # Increment 4 - incidents + raw evidence -> agentRuns
```

Increment 1: ICMP health checks -> `device_unreachable` / `device_recovered`.
Increment 2: Layer 0 tails FRR logs -> `networkLogs/` + four normalized event
types with a `sourceLogId` back-reference.
Increment 3: the Incident Service correlates events into `incidents/` with a
deterministic root cause. **It tells a link failure apart from a router failure
even though both produce identical ICMP symptoms** — that is the headline
result; do not regress it.

Increment 4: the Agent Service reads settled incidents and their complete
event/log evidence chain, calls `gpt-5.6-luna` with low reasoning through the
Responses API, and records its lifecycle, independent conclusion, citations,
agreement, usage, latency and cost in `agentRuns/`. It is read-only by
construction and has no network/action capability. Unit/build verification is
green; the paid two-scenario e2e passed on 2026-08-26 with one link-failure and
one router-failure conclusion, both agreeing with the deterministic baseline.

There is also an Angular NOC dashboard (`apps/web`, `npm run web`,
<http://localhost:4200>) with a unified live pipeline timeline and manual lab
fault buttons. Firestore access is read-only. Buttons call the separate
localhost-only `services/lab-controller`, which accepts five named ISP-style
fault scenarios plus restore and writes their audit/output records to `labActions/`.
It is not connected to GPT and is not the future general Network Controller.

### The next action

Use the operator visualizer to demonstrate the complete loop. Increment 5's
controlled-action design is still next; do not mistake the three hard-coded
manual lab scenarios for AI action authority or add actions to the investigator
before the risk/approval boundary exists.

Verify what is actually running before assuming anything:

```bash
for ip in 10.255.0.1 10.255.0.2 10.255.0.3 10.0.1.2 10.0.3.2; do
  ping -c1 -W1 -n $ip >/dev/null 2>&1 && echo "$ip UP" || echo "$ip DOWN"
done
curl -sf http://127.0.0.1:8080/ >/dev/null && echo "emulator UP"
ps -eo pid,args | grep -E 'dist/index.js|tsx' | grep -v grep   # strays?
```

**A host reboot silently guts the lab.** Containers come back and FRR keeps its
config, so the routers *look* fine — but the containerlab veth pairs are gone
(`eth1`/`eth2` simply absent, OSPF shows zero neighbours) and the host routes
are gone with them. Recovery, and neither step is optional:

```bash
containerlab deploy --topo lab/topology.clab.yml --reconfigure   # no sudo needed
sudo ip route replace 10.255.0.0/24 via 172.20.20.11             # Willem must run
sudo ip route replace 10.0.0.0/16 via 172.20.20.11               # Willem must run
```

Prefer that over `./lab/deploy.sh` when the lab was only route-broken —
deploy.sh `--reconfigure`s unconditionally. Note `06-restore-network.sh` polls
`ping 10.255.0.3` **from the host**, so it fails without those routes even when
the lab itself is healthy.

The current five-category lab no longer stops whole containers; historical
whole-router scenarios required topology redeployment because a stopped
container lost its veth pairs.

## Environment traps

**Docker group staleness.** `install-prereqs.sh` runs `usermod -aG docker`, but
any process started *before* that does not carry the group and gets
`permission denied` on `/var/run/docker.sock`. `sg` and `newgrp` are **not
installed on this host**, so the group cannot be acquired mid-session — only a
new login session fixes it. `lab/lib/docker.sh::resolve_docker` detects this
precisely; always source it rather than calling `docker` raw. Check with:

```bash
id -nG $USER   # includes docker
id -nG         # this process — may not
```

**sudo requires an interactive password.** An agent cannot run it. Anything
needing root (`ip route`) must be run by Willem. `deploy.sh` skips the sudo
prompt entirely when the host routes are already present.

**containerlab is setuid root** (`-rwsr-xr-x`) but drops to uid 1000 and reaches
Docker as the invoking user — so it needs **no sudo** once the docker group is
live, and setuid does *not* rescue a stale group.

**This ISP answers ICMP for `192.0.2.1`** (TEST-NET-1, `ttl=241`, ~50ms) despite
RFC 5737. Never assume documentation ranges are unroutable in a test — probe
first and skip honestly. See `tests/ping.test.ts`.

**The lab may already be up.** Check before deploying; `deploy.sh --reconfigure`
rebuilds it needlessly.

**FRR logging fails silently, in four separate ways.** All of these leave the
daemon up and the config reading back correctly, with no events on disk:

- `docker logs` is useless — FRR daemonizes and stops writing to container
  stdout after startup.
- ospfd and staticd **reject a runtime `log file`** for any path, including
  world-writable ones; zebra and mgmtd accept it. Log destinations are therefore
  `--log file:` startup flags in `lab/configs/daemons`, one file per daemon.
- ospfd cannot write to `/var/run/frr` — zebra opens its log while still root,
  ospfd opens its own after dropping to `frr`. Hence the `lab/logs/<router>` ->
  `/var/log/frr` bind mount, created mode 777 by `deploy.sh`.
- Those files land root-owned mode 600 on the host, so host-side reads need
  root. Layer 0 goes through `docker exec … tail -F`.

Interface events need `debug zebra events`; adjacency events need
`log-adjacency-changes detail`. Measured cost: **zero** lines in 30s of steady
state — the volume is entirely burst-driven by topology changes.

**Killing a service by pid orphans it — `setsid` did NOT fix this.** `npx tsx`
builds a four-deep chain (`npx` -> `npm exec` -> `sh -c` -> `node`); signalling
`$!` kills a wrapper and leaves node running, still writing to Firestore. This
corrupted two runs: one left a Health Service emitting events 39 minutes after
its test finished, another left a second Incident Service fighting the first
over the same `INC-001` document.

**The signature is every event type appearing exactly twice.** If assertions
show events nobody started, or duplicate counts, look for strays first:

```bash
ps -eo pid,args | grep -E 'dist/index.js|tsx' | grep -v grep
```

All e2e scripts now run the built `dist/index.js` — one process, killable —
via `scripts/lib/services.sh`, which also sweeps leftovers before and after
every run. Use those helpers rather than inventing new process handling.

---

## Design decisions — do not undo

**Health checks target loopbacks, never management addresses.** This is the
load-bearing decision. Containerlab management IPs (172.20.20.0/24) stay up when
the data plane breaks, so pinging them would make link failures *invisible* and
the whole demo would prove nothing. Routers carry OSPF-advertised loopbacks
(10.255.0.1–3/32); `deploy.sh` adds host routes via r1 so the service reaches
them through the emulated network. Management addresses stay in `devices/`
because the Network Controller needs them for vtysh in Increment 5.

**ICMP shells out to `/bin/ping`.** Raw sockets need `CAP_NET_RAW`; `ping`
already has it. No native deps, no setcap, runs unprivileged.

**Exit-code discipline.** `ping` exit 1 = real outage. Any other non-zero =
broken check, recorded with a `check failed:` prefix. An operational blind spot
must never be reported as a device outage.

**First observation seeds a baseline, emits nothing.** Otherwise every restart
would emit phantom `device_unreachable` events.

**Failure isolation (security rule 8).** `checkDevice` never throws; Firestore
errors are caught per collection; `tick` has a final catch. Monitoring must
survive the failure of everything above it. Never let a write error propagate
into the loop.

**Latency precision scales to magnitude.** Container RTT is ~0.04ms; `toFixed(1)`
renders every healthy check as a misleading `0.0ms`.

**Layer 0 stores the raw line even when it cannot parse it.** A parser gap must
stay visible and recoverable; silently dropping what a device actually said is
how monitoring comes to quietly lie. `parsed` and `normalized` flags record how
far each line got.

**Normalization is separate from parsing.** `parser.ts` splits FRR's envelope
without assigning meaning; `rules.ts` decides what a message is. Returning no
event is the common case — the intermediate OSPF states (`Init`, `ExStart`,
`Exchange`, `Loading`) are dropped deliberately, since one recovery walks
through all four and an event per step would bury the transition that matters.

**The raw log and its event are written in one batch**, with the log's id
generated locally first. So `networkEvents` never points at a `networkLogs`
document that does not exist, and `sourceLogId` costs no extra round trip.

**Layer 0 does not decide what is an incident.** It emits events and stops.
The Incident Service correlates and diagnoses but never remediates. Both
boundaries are deliberate — correlation in the normalizer could not be changed
without re-parsing history, and remediation in the correlator would skip the
risk policy Increments 5 and 6 exist to provide.

**Correlation is deterministic, and must stay that way.** No LLM in Increment 3;
GPT-5.6 Luna enters in Increment 4 over incidents that already exist. An inference
nobody can reproduce is not a baseline to improve on.

**The Increment 4 agent is structurally read-only.** It reads incidents,
events and raw logs and writes only `agentRuns/`. It owns no Docker, SSH,
`vtysh`, controller or action tool. Each diagnosis version gets one
deterministic run id, so listener replays and recovery events cannot multiply
paid calls. API failures become failed run records and never propagate into
monitoring.

**The link-vs-device discriminator is: did the far end corroborate?** Both ends
reporting means both devices are alive and the link is not. One end reporting
while the silent peer is unreachable means that peer failed. This is the whole
payoff of Increment 2 — do not let it regress.

**A root cause states what it predicts should be unreachable** (topology graph
minus the failure) next to what was observed. A diagnosis that does not predict
the symptoms is worth doubting, so mismatches are recorded, never hidden.

**Use the appropriate recovery signal.** FRR log
timestamps have one-second resolution, so a down/up pair in the same second
arrives in arbitrary order; seen "up" first, the trailing "down" re-opens a
fault nothing ever clears. Recovery events also vanish when the collector
reattaches its tail during a redeploy. Native connectivity faults therefore
follow reachability, which the Health Service continuously re-checks. Persistent
configuration, session, admin, service, and resource faults instead stay open
until the autonomous observer emits their matching recovery transition.

**Freeze the root cause once it is definite.** Re-inferring after recovery let a
restored r3 exonerate itself, turning a correct device failure into a
"confirmed link failure". Only events before the first recovery are evidence.

**The dashboard's Firestore access is read-only and emulator-only.** Client
writes are denied everywhere; reads are open for the seven displayed
collections. `allow read: if true` must become per-user auth before any real
deployment (Increment 7). Manual lab buttons call a separate localhost-only
controller with fixed scenario routes; they are not Firestore writes and do not
give GPT action authority. A browser app talks to the emulator with the ordinary
Firebase SDK — a real Firebase project was never needed for a local UI.

---

## Layout & commands

```
lab/        topology.clab.yml, FRR configs, scenarios, lib/docker.sh
services/health-service/   Increment 1 — ICMP -> Firestore
services/layer-zero/       Increment 2 — FRR logs -> networkLogs + networkEvents
services/incident-service/ Increment 3 — networkEvents -> incidents
services/agent-service/    Increment 4 — GPT investigation -> agentRuns
services/lab-controller/   Manual local-lab scenarios -> labActions
apps/web/                  Angular operator visualizer (live pipeline + controls)
firebase/   rules + indexes      scripts/  e2e test, assertions, reset
docs/       architecture.md, data-model.md, incident-model.md
```

```bash
npm run start:all        # complete local stack; Ctrl+C owns cleanup
npm test                  # unit tests across telemetry, agent and lab controller
npm run build             # tsc
npm run emulators         # Firestore :8080, UI :4000
npm run health-service    # Increment 1 service
npm run layer-zero        # Increment 2 service
npm run incident-service  # Increment 3 service
npm run agent-service     # Increment 4 service (needs OPENAI_API_KEY for success)
npm run lab-controller    # localhost-only manual lab control API on :8787
npm run web               # NOC dashboard on :4200
./lab/deploy.sh           # deploy + host routes (sudo only if routes missing)
./lab/verify.sh           # connectivity proof
./lab/scenarios/03-interface-disabled.sh # administratively disable R2 eth2
./lab/scenarios/06-restore-network.sh    # restore every ISP fault scenario
./scripts/reset-firestore.sh          # wipe emulator
./scripts/e2e-layer-zero.sh           # Increment 2 end-to-end
./scripts/e2e-incidents.sh            # live-lab E2E (runs all five scenarios)
./scripts/e2e-failure-categories.mjs  # focused credit-free failure-path E2E
./scripts/e2e-agent.sh                # Increment 4 end-to-end (uses GPT-5.6 Luna)
./lab/destroy.sh          # tear down + remove routes
```

`scripts/start-all.sh` is the preferred interactive launcher. It requires a key
from the shell or `services/agent-service/.env` unless `ACN_SKIP_AGENT=1`,
verifies/deploys the lab, reuses no unrelated ports, runs built single-process
backend artifacts, records logs under `.acn-runtime/`, and kills only the
process groups it started on Ctrl+C. Do not replace it with concurrent npm
wrappers that orphan child processes.

Topology: `PC1—R1—R2—R3—PC2`, FRR 10.2.1, OSPF area 0. Interface naming matters
— `r2:eth2` faces r3. Addressing table is in `README.md`.

---

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`. Keep it clean.
- Small, testable commits; conventional-commit prefixes.
- **Work on the feature branch, not `main`.** Current:
  `4-increment-4-gpt-investigator`. Remote:
  `WillemSmit7/acn` (private).
- Never commit credentials. Emulator needs none; production uses ADC. The
  OpenAI key belongs only in `services/agent-service/.env`, never `apps/web`.
- Do not build future increments' infrastructure early. Placeholder READMEs in
  `network-controller` are intentional. `apps/web`
  is the one deliberate exception, pulled forward and kept to a viewer.
- Parser fixtures must be lines copied verbatim from the running lab. Parsers
  written against imagined log formats pass their tests and fail in production.
