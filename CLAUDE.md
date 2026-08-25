# ACN — AI-Centered Network

Network-operations environment: collect network data, normalize it, store it,
and eventually let an AI agent investigate and remediate. Built strictly in
increments per `ACN_IMPLEMENTATION_PLAN.md`.

**Read `PROGRESS.md` first** — it is the authoritative status record. This file
holds the durable context and the traps that cost real time.

---

## Current state: Increment 1, 11/15 criteria verified

The lab is deployed and OSPF-converged. The Health Service has been verified
against the **real** topology. What remains is the fault half: break the R2–R3
link, observe the events, restore.

### The next action

With the lab and Firestore emulator running, one command finishes Increment 1:

```bash
./scripts/e2e-test.sh
```

It clears the emulator, restores the baseline, starts the service at 5s
intervals, breaks R2–R3, restores it, and asserts the Firestore contents.
Needs Docker access (see below). No sudo if host routes already exist.

Verify what is actually running before assuming:

```bash
for ip in 10.255.0.1 10.255.0.2 10.255.0.3 10.0.1.2 10.0.3.2; do
  ping -c1 -W1 -n $ip >/dev/null 2>&1 && echo "$ip UP" || echo "$ip DOWN"
done
curl -sf http://127.0.0.1:8080/ >/dev/null && echo "emulator UP"
```

**Do not start Increment 2** until `./scripts/e2e-test.sh` passes.

---

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

---

## Layout & commands

```
lab/        topology.clab.yml, FRR configs, scenarios, lib/docker.sh
services/health-service/   Increment 1 — ICMP -> Firestore
firebase/   rules + indexes      scripts/  e2e test, assertions, reset
docs/       architecture.md, data-model.md, incident-model.md
```

```bash
npm test                  # 18 unit tests
npm run build             # tsc
npm run emulators         # Firestore :8080, UI :4000
npm run health-service    # the service
./lab/deploy.sh           # deploy + host routes (sudo only if routes missing)
./lab/verify.sh           # connectivity proof
./lab/scenarios/01-link-failure.sh    # break R2 eth2
./lab/scenarios/03-restore-network.sh # restore
./scripts/reset-firestore.sh          # wipe emulator
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
  `services/layer-zero`, `incident-service`, `agent-service`,
  `network-controller`, `apps/web` are intentional.
