# Increment 4 handoff — Claude as a read-only investigator

Written 2026-08-26 for an agent picking this up cold.

**Read these first, in this order:** `CLAUDE.md` (durable context and the traps
that cost real time), `PROGRESS.md` (authoritative status), then
`docs/incident-model.md` (what Increment 3 concluded and why). This file does
not repeat them — it tells you where things actually stand, what Increment 4 is,
and what will bite you.

---

## 1. Verified state right now

Increments 1, 2 and 3 are complete and committed. **82 unit tests pass**
(18 health-service, 25 layer-zero, 39 incident-service) — I ran them while
writing this.

| Increment | What it does | End-to-end test |
|---|---|---|
| 1 | ICMP checks → `device_unreachable` / `device_recovered` | `./scripts/e2e-test.sh` (8 assertions) |
| 2 | Layer 0 tails FRR logs → `networkLogs/` + 4 normalized event types | `./scripts/e2e-layer-zero.sh` (16 assertions) |
| 3 | Correlates events → `incidents/` with a deterministic root cause | `./scripts/e2e-incidents.sh` (16 assertions, runs **both** fault scenarios) |

There is also a read-only Angular NOC dashboard at `apps/web` (`npm run web`,
<http://localhost:4200>), pulled forward from Increment 7 deliberately. It is
the one intentional exception to "don't build future increments early".

**Branch:** `3-increment-3-incident-correlation`, 15 commits ahead of `main`,
not merged, not pushed. Increment branches are stacked, each off the previous.
Create `4-increment-4-claude-investigator` off this one.

**One uncommitted change:** `apps/web/angular.json` adds `"analytics": false`.
Trivial — it suppresses the Angular CLI analytics prompt. Commit it or drop it,
but don't leave it as a mystery.

### The headline result you must not regress

Increment 3 tells a **link failure** apart from a **router failure** even though
both produce byte-identical ICMP symptoms (r3 and pc2 unreachable, every time).
The discriminator is: *did the far end corroborate?* Both ends reporting means
both devices are alive and the link is not. One end reporting while the silent
peer is unreachable means that peer died — a dead router cannot file a report.

`./scripts/e2e-incidents.sh` exists specifically to prove those two scenarios
yield **different root causes from identical observed symptoms**. If your change
makes that test pass trivially or stop distinguishing them, you have broken the
point of the whole project.

---

## 2. The lab is currently BROKEN — fix it before you trust anything

Right now: containers are up, FRR kept its config, and the routers *look* fine.
They are not. This is the documented reboot trap and it is live as I write:

```
r1 interfaces:  lo + eth0 only   <-- eth1/eth2 (the containerlab veths) are GONE
r1 OSPF:        zero neighbours
host routes:    10.255.0.0/24 and 10.0.0.0/16 both absent
```

Recovery — **neither step is optional**:

```bash
containerlab deploy --topo lab/topology.clab.yml --reconfigure   # no sudo needed
sudo ip route replace 10.255.0.0/24 via 172.20.20.11             # Willem must run
sudo ip route replace 10.0.0.0/16 via 172.20.20.11               # Willem must run
```

**You cannot run the `sudo` lines.** sudo on this host always requires an
interactive password; there is no passwordless path and `sg`/`newgrp` are not
installed. Batch them into one explicit ask to Willem rather than blocking the
whole task — do all the Docker-side work yourself first.

Prefer the two commands above over `./lab/deploy.sh` when the lab is only
route-broken: `deploy.sh` runs `--reconfigure` unconditionally and rebuilds a
lab that was fine.

### A false-positive that will mislead you

With the host routes missing, I found `ping 10.0.3.2` **succeeds** — while every
other lab address fails. It is not the lab. With no route, the packet takes the
default gateway and this ISP answers for it:

```
$ ip route get 10.0.3.2
10.0.3.2 via 192.168.1.1 dev wlo1 ...
```

So a naive reachability check reports pc2 healthy while the entire lab is down.
This is the same class of trap as the documented "this ISP answers ICMP for
`192.0.2.1` (TEST-NET-1) despite RFC 5737". **Verify with `ip route get`, not
with a bare ping.** Always confirm the two host routes exist before believing
any reachability result.

### Verify before assuming

```bash
for ip in 10.255.0.1 10.255.0.2 10.255.0.3 10.0.1.2 10.0.3.2; do
  ping -c1 -W1 -n $ip >/dev/null 2>&1 && echo "$ip UP" || echo "$ip DOWN"
done
ip route show 10.255.0.0/24                       # must be via 172.20.20.11
curl -sf http://127.0.0.1:8080/ >/dev/null && echo "emulator UP"
ps -eo pid,args | grep -E 'dist/index.js|tsx' | grep -v grep   # strays?
```

The Firestore emulator is **currently down** — start it with `npm run emulators`.

Note: there are two `ng serve` processes running (`IonBase_Web`, and one with
`--configuration qa`). They belong to a **different project**, not this one.
Leave them alone.

---

## 3. What Increment 4 is

> Claude as a **read-only investigator** over incidents that already exist.

It does **not** correlate (that is Increment 3, and it is deterministic on
purpose) and it does **not** act (that is Increments 5 and 6, gated by a risk
policy that does not exist yet). It reads an incident, follows the evidence
chain down to the raw log lines, and writes its reasoning to `agentRuns/`.

Everything it needs is already in place, and this was built deliberately:

- `incidents/` carries `eventIds`
- `networkEvents/` carries `sourceLogId`
- `networkLogs/` carries the untouched original text

So the chain **incident → events → raw device output** is fully traversable. An
agent that cannot show the text a device actually emitted is producing opinions,
not findings.

### Why the deterministic baseline matters

Increment 3 already produces a root cause, a confidence level, plain-language
evidence, and a predicted-vs-observed self-check. That gives the agent something
to **agree or disagree with** rather than a blank page — and it makes the
agent's contribution measurable. Keep it that way. If you find yourself wanting
to replace the deterministic correlator with an LLM call, don't: an inference
nobody can reproduce is not a baseline to improve on.

The most interesting case to build for is **disagreement**. When the agent's
reading of the evidence differs from the deterministic verdict, that is signal —
either the rules need work or the agent is wrong, and both are worth surfacing.
Do not design a flow where the agent can only rubber-stamp.

### `agentRuns/` — the collection you will create

It is listed in `docs/data-model.md` as Increment 4, written by the Agent
Service, but **its shape is not yet specified**. That is your call. Design it so
it answers, at minimum:

- which incident was investigated, and against which version of its diagnosis
- what the agent concluded, and how confident it was
- **which evidence it actually looked at** (event ids, log ids) — not a summary,
  the actual references
- whether it agreed with the deterministic root cause
- the model used, token usage, latency, and cost
- what it was asked (the prompt, or a stable reference to it) so a run can be
  reproduced or argued with

Add it to `docs/data-model.md` in the same style as the implemented
collections, and add whatever composite indexes it needs to
`firebase/firestore.indexes.json`.

---

## 4. The UI — Willem asked for this explicitly

**Willem specifically wants to be able to watch the agent working**, in the
Angular app, not only in a terminal or in Firestore. Treat that as part of the
increment, not a nice-to-have. His words were that he wants a UI "so we can log
on and see how it's working."

`apps/web` already exists and is a good citizen — a read-only viewer that
renders the path the data takes:

```
apps/web/src/app/
  data.service.ts                    live Firestore queries (devices, healthChecks,
                                     networkEvents, incidents, networkLogs)
  models.ts                          typed shapes
  firebase.ts                        emulator connection
  components/topology-strip.component.ts   PC1—R1—R2—R3—PC2 in cabling order
  components/incident-detail.component.ts  verdict, evidence, predicted-vs-observed
  components/event-feed.component.ts       live stream, tagged ICMP or LOG
```

Extend it with an agent view: the run, its conclusion, whether it agreed with
the deterministic verdict, and the evidence it cited — ideally letting you click
from a cited event through to the raw log line. Follow the existing patterns
(standalone components, the `DataService` query style) rather than inventing a
second approach.

**Keep it read-only and emulator-only.** `firebase/firestore.rules` denies all
client writes and opens reads for the displayed collections. If you add
`agentRuns` to the dashboard, add it to the rules the same way. `allow read: if
true` must become per-user auth before any real deployment — that is Increment 7
and is already recorded as such. Do not add client-side writes to trigger agent
runs; if you want a trigger, the service polls or watches Firestore.

---

## 5. Constraints you must honour

These are load-bearing decisions from `CLAUDE.md`. Do not undo them:

- **Never let the agent remediate.** No `vtysh`, no `docker exec`, no config
  changes. Read-only means read-only. Increments 5 and 6 add actions *and* the
  risk policy that gates them, together and in that order.
- **Failure isolation (security rule 8).** An AI or database failure must never
  take down monitoring. The agent service must not be able to stall or crash the
  Health Service, Layer 0, or the Incident Service. Catch everything; a failed
  run is a recorded failed run, not an exception that propagates.
- **Never commit credentials.** The emulator needs none. The Anthropic API key
  goes in a gitignored `.env` (`.env` and `.env.*` are already ignored, with
  `!.env.example` kept) and is documented in `services/agent-service/.env.example`
  with a placeholder. `ANTHROPIC_API_KEY` is **not** currently set in the shell.
- **Cost and rate limits are real.** The lab can produce incidents faster than
  you want to pay for. Make runs deliberate — one per incident diagnosis, not
  one per event — and record token usage so the cost is visible rather than a
  surprise.
- **TypeScript `strict` + `noUncheckedIndexedAccess`.** Keep it clean.
- **Parser/prompt fixtures must be real.** Increment 2's rule was that parser
  fixtures are lines copied verbatim from the running lab, because parsers
  written against imagined formats pass their tests and fail in production. The
  same applies to agent tests: build them from real stored incidents, not
  invented ones.
- **Do not build Increment 5+ infrastructure early.** The placeholder READMEs in
  `services/network-controller` are intentional.

### Model selection

Use a current model. **Load the `claude-api` skill before writing any API
code** — it carries the current model ids, pricing, and parameters, and it is
the documented trigger for exactly this situation. Do not hardcode a model id
from memory.

---

## 6. Traps that have already cost real time

All of these are in `CLAUDE.md` in full. The short version:

**Killing a service by pid orphans it — `setsid` did NOT fix this on its own.**
`npx tsx` builds a four-deep process chain; signalling `$!` kills a wrapper and
leaves node running and still writing to Firestore. This corrupted two runs: one
left a Health Service emitting events 39 minutes after its test finished,
another left a second Incident Service fighting the first over the same
`INC-001` document. **The signature is every event type appearing exactly
twice.** If assertions show events nobody started, or doubled counts, look for
strays before debugging your logic:

```bash
ps -eo pid,args | grep -E 'dist/index.js|tsx' | grep -v grep
```

All e2e scripts now run the built `dist/index.js` — one process, killable — via
`scripts/lib/services.sh`, which sweeps leftovers before and after every run.
**Use those helpers rather than inventing new process handling.**

**Docker group staleness.** A process started before `usermod -aG docker` took
effect gets permission denied on the socket and cannot acquire the group
mid-session. Compare `id -nG` against `id -nG $USER`. `lab/lib/docker.sh::resolve_docker`
detects this precisely — source it rather than calling `docker` raw. (It is
working fine in fresh sessions right now.)

**Stopping a container destroys its veth pairs**, same symptom as the reboot
trap. `03-restore-network.sh` redeploys the links after restarting a container
for exactly this reason. Note it polls `ping 10.255.0.3` **from the host**, so it
fails without the host routes even when the lab itself is healthy.

**FRR logging fails silently in four separate ways** — all leaving the daemon up
and the config reading back correctly with no events on disk. If you touch the
lab's logging, read that section of `CLAUDE.md` first; it took four attempts to
get right.

---

## 7. Suggested acceptance criteria

Increments here are judged by an end-to-end test against the real lab, not by
unit tests alone. Follow the existing pattern: `scripts/e2e-agent.sh` plus
`scripts/assert-agent.mjs`, modelled on `scripts/e2e-incidents.sh`.

1. An `agentRuns/` document is created for an investigated incident
2. The run cites specific `networkEvents` and `networkLogs` ids, and every one
   resolves to a real document
3. The agent's conclusion is recorded alongside the deterministic root cause,
   with explicit agreement/disagreement
4. It investigates **both** fault scenarios and its output differs between them
   — same as Increment 3's bar, since identical ICMP symptoms is the hard case
5. Token usage and cost are recorded
6. An API failure (bad key, timeout, rate limit) produces a recorded failed run
   and does not disturb the other services
7. The dashboard shows agent runs live
8. No credentials are committed
9. Increments 1–3 still pass: re-run all three e2e scripts

---

## 8. Commands

```bash
npm test                  # 82 unit tests across the three services
npm run build             # tsc, all workspaces
npm run emulators         # Firestore :8080, UI :4000
npm run health-service    # Increment 1
npm run layer-zero        # Increment 2
npm run incident-service  # Increment 3
npm run web               # dashboard on :4200

./lab/deploy.sh                       # deploy + host routes (sudo only if missing)
./lab/verify.sh                       # connectivity proof
./lab/scenarios/01-link-failure.sh    # break R2 eth2
./lab/scenarios/02-router-failure.sh  # stop r3
./lab/scenarios/03-restore-network.sh # restore
./scripts/reset-firestore.sh          # wipe emulator

./scripts/e2e-test.sh         # Increment 1
./scripts/e2e-layer-zero.sh   # Increment 2
./scripts/e2e-incidents.sh    # Increment 3 (runs BOTH scenarios)
```

Topology: `PC1—R1—R2—R3—PC2`, FRR 10.2.1, OSPF area 0. Interface naming matters
— `r2:eth2` faces r3. Addressing is in `README.md`.

Conventions: work on the increment branch, never `main`; small commits with
conventional-commit prefixes; update `PROGRESS.md` and `CLAUDE.md` when the
increment lands, since those are what the next agent reads first.

---

## 9. One correction to carry forward

`CLAUDE.md` opens by saying the project is built "strictly in increments per
`ACN_IMPLEMENTATION_PLAN.md`". **That file does not exist** — not in the working
tree and not anywhere in git history. Increments 2 and 3 were scoped from
`PROGRESS.md` instead, which has worked fine. Either add the plan or drop the
reference; right now it sends every new agent looking for a file that was never
there.
