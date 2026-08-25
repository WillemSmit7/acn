# ACN — AI-Centered Network

Network-operations environment: collect network data, normalize it, store it,
and eventually let an AI agent investigate and remediate. Built strictly in
increments per `ACN_IMPLEMENTATION_PLAN.md`.

**Read `PROGRESS.md` first** — it is the authoritative status record. This file
holds the durable context and the traps that cost real time.

---

## Current state: Increments 1 and 2 complete

Both end-to-end tests pass against the real lab:

```bash
./scripts/e2e-test.sh         # Increment 1 - ICMP -> Firestore, 8 assertions
./scripts/e2e-layer-zero.sh   # Increment 2 - FRR logs -> events, 16 assertions
```

Increment 1: ICMP health checks, `device_unreachable` / `device_recovered`.
Increment 2: Layer 0 tails FRR logs, stores raw lines in `networkLogs/`, and
normalizes four event types into `networkEvents/` with a `sourceLogId`
back-reference. A single R2-R3 link failure is observed from both ends.

### The next action

Increment 3 — incident detection and correlation. See PROGRESS.md.

Verify what is actually running before assuming anything:

```bash
for ip in 10.255.0.1 10.255.0.2 10.255.0.3 10.0.1.2 10.0.3.2; do
  ping -c1 -W1 -n $ip >/dev/null 2>&1 && echo "$ip UP" || echo "$ip DOWN"
done
curl -sf http://127.0.0.1:8080/ >/dev/null && echo "emulator UP"
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
deploy.sh `--reconfigure`s unconditionally. Note `03-restore-network.sh` polls
`ping 10.255.0.3` **from the host**, so it fails without those routes even when
the lab itself is healthy.

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

**Killing a service by pid orphans it.** `npm run …` / `npx tsx` spawn a
grandchild that survives a kill on the wrapper and keeps writing to Firestore,
silently polluting later runs. Both e2e scripts now use `setsid` and signal the
process group. If assertions show events nobody started, check for strays:
`ps -eo pid,args | grep tsx`.

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
Correlation is Increment 3; putting that inference in the normalizer would make
it impossible to change later without re-parsing history.

---

## Layout & commands

```
lab/        topology.clab.yml, FRR configs, scenarios, lib/docker.sh
services/health-service/   Increment 1 — ICMP -> Firestore
services/layer-zero/       Increment 2 — FRR logs -> networkLogs + networkEvents
firebase/   rules + indexes      scripts/  e2e test, assertions, reset
docs/       architecture.md, data-model.md, incident-model.md
```

```bash
npm test                  # 43 unit tests across both services
npm run build             # tsc
npm run emulators         # Firestore :8080, UI :4000
npm run health-service    # Increment 1 service
npm run layer-zero        # Increment 2 service
./lab/deploy.sh           # deploy + host routes (sudo only if routes missing)
./lab/verify.sh           # connectivity proof
./lab/scenarios/01-link-failure.sh    # break R2 eth2
./lab/scenarios/03-restore-network.sh # restore
./scripts/reset-firestore.sh          # wipe emulator
./scripts/e2e-layer-zero.sh           # Increment 2 end-to-end
./lab/destroy.sh          # tear down + remove routes
```

Topology: `PC1—R1—R2—R3—PC2`, FRR 10.2.1, OSPF area 0. Interface naming matters
— `r2:eth2` faces r3. Addressing table is in `README.md`.

---

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`. Keep it clean.
- Small, testable commits; conventional-commit prefixes.
- **Work on the feature branch, not `main`.** Current:
  `1-increment-1-emulated-network-health-service-firestore`. Remote:
  `WillemSmit7/acn` (private).
- Never commit credentials. Emulator needs none; production uses ADC.
- Do not build future increments' infrastructure early. Placeholder READMEs in
  `services/incident-service`, `agent-service`, `network-controller`,
  `apps/web` are intentional.
- Parser fixtures must be lines copied verbatim from the running lab. Parsers
  written against imagined log formats pass their tests and fail in production.
