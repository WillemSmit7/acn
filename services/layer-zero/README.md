# Layer 0 — raw device logs to normalized networkEvents

**Increment 2 — implemented.**

Layer 0 combines FRR log collection with an autonomous, read-only state
observer. It stores exact log lines and command output in `networkLogs/`, and
writes a `networkEvents/` document for meaningful transitions. Every event
records the `sourceLogId` of its evidence, so the original observation behind a
conclusion is one lookup away.

The observer polls fixed, repository-owned commands for the five supported lab
conditions. Scenario scripts only inject faults; they do not announce what they
changed or write monitoring events. Healthy startup seeds a quiet baseline, a
fault already present at startup is emitted immediately, unchanged states are
deduplicated, and restoration emits the matching recovery event.

```bash
npm run layer-zero          # from the repo root, with the lab and emulator up
./scripts/e2e-layer-zero.sh # full break/restore cycle plus assertions
```

## Event types

| `eventType`          | `severity` | Source line |
|----------------------|------------|-------------|
| `interface_down`     | `warning`  | zebra `ZEBRA_INTERFACE_DOWN` |
| `interface_up`       | `info`     | zebra `ZEBRA_INTERFACE_UP` |
| `ospf_neighbor_down` | `warning`  | ospfd `AdjChg: ... -> Deleted\|Down` |
| `ospf_neighbor_up`   | `info`     | ospfd `AdjChg: ... -> Full` |
| `configuration_drift` / `configuration_restored` | `warning` / `info` | R2 running configuration |
| `routing_session_down` / `routing_session_up` | `warning` / `info` | R2 OSPF passive-interface state |
| `interface_admin_down` / `interface_admin_up` | `warning` / `info` | R2 eth2 administrative state |
| `routing_service_down` / `routing_service_up` | `critical` / `info` | R3 ospfd process state |
| `resource_exhaustion` / `resource_recovered` | `critical` / `info` | R3 CPU quota plus process state |

Severity describes what a line means on its own. A down interface is a strong
signal but not by itself an outage — deciding whether it amounts to one is
correlation, which belongs to Increment 3.

## Layout

```
src/collector/logTail.ts   follows log files inside a container
src/observer/              fixed read-only probes and transition tracking
src/normalize/parser.ts    FRR line -> structured envelope
src/normalize/rules.ts     structured envelope -> network event
src/pipeline.ts            buffering, batching, failure isolation
src/config/sources.ts      which containers and files to read
```

## Design notes

**Raw first, always.** The unmodified line is stored whether or not anything
could be made of it. A parser gap has to stay visible and recoverable; silently
dropping text the device actually emitted is how monitoring systems come to
quietly lie.

**Normalization is separate from parsing.** `parser.ts` splits FRR's envelope
without assigning meaning; `rules.ts` decides what a message *is*. An
unrecognised message therefore still yields a well-formed stored record.

**Returning no event is the common case.** FRR is far chattier than the set of
things worth reasoning about. The intermediate states of a forming OSPF
adjacency (`Init`, `ExStart`, `Exchange`, `Loading`) are deliberately dropped:
one link recovery walks through all four, and an event per step would bury the
single transition that matters.

**Failure isolation.** A malformed line, a throwing rule, a dead tail process
and a Firestore outage are all contained. Collection must survive the failure
of everything layered on top of it (security rule 8).

## Why the logs are read the way they are

Three constraints, all found the hard way against the real lab. They are the
reason the plumbing looks more elaborate than "read a log file":

1. **`docker logs` is useless here.** FRR daemonizes, so once watchfrr forks
   the daemons their output stops reaching the container's stdout. After
   startup the container log is silent — a link failure leaves no trace in it.

2. **ospfd cannot open a log file in `/var/run/frr`.** zebra opens its log while
   still root; ospfd opens its own only after dropping to the `frr` user, and
   then fails — silently. ospfd stays up and adjacency changes simply never
   reach disk. Each router therefore bind-mounts `lab/logs/<router>/` at
   `/var/log/frr`, created mode 777 by `deploy.sh`.

3. **The files land on the host as root-owned mode 600**, so reading them from
   the host side would need root. Collection goes back through
   `docker exec … tail -F` instead, which can read them.

`log file` in `frr.conf` does not work either — ospfd rejects the runtime
command. The per-daemon destinations are set as `--log` startup flags in
`lab/configs/daemons`.

See [../../docs/architecture.md](../../docs/architecture.md) for where this sits
in the layering and [../../PROGRESS.md](../../PROGRESS.md) for status.
