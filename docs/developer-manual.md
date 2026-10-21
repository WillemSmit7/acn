# ACN Developer Manual

This manual is for developers changing, testing, and troubleshooting ACN. It
complements rather than replaces the operator setup in the [root README](../README.md)
and the component-specific notes linked below.

## Network data plane and ACN data pipeline

ACN monitors the **network data plane**: the routed path through the emulated
routers and hosts, tested through their loopback and host addresses. ACN also
has a **telemetry and investigation data pipeline**: collectors observe that
network, persist evidence, correlate events into incidents, and let the
read-only Agent Service investigate those incidents. These terms describe
different things; use “data plane” for network forwarding and “pipeline” or
“processing flow” for ACN's software.

## Start here

Before making changes, read [PROGRESS.md](../PROGRESS.md). It is the authoritative
record of what is implemented, what is next, and environment-specific traps.
In particular, do not treat the planned Network Controller flow as running
code: the current Agent Service is read-only, and the Lab Controller is a
separate manual tool for the synthetic lab.

The [architecture guide](./architecture.md) describes system boundaries,
[FunctionDiagrams.md](./FunctionDiagrams.md) describes component responsibilities
and illustrates implemented and planned flows, and the [data model](./data-model.md)
and [incident model](./incident-model.md) document persisted records and
correlation behavior.

## Set up and run locally

The supported development environment is Ubuntu with Node.js 20+, npm, Java
11+ (for the Firestore emulator), Docker Engine, and Containerlab. Follow the
prerequisites and initial setup in the [root README](../README.md), then install
workspace dependencies with `npm install`.

Copy the relevant service `.env.example` files to `.env` before starting
individual services. Keep real credentials out of source control. The
`OPENAI_API_KEY` belongs only in `services/agent-service/.env` or the shell
environment; never put it in `apps/web` or a browser-visible configuration.
Local development should use the Firestore emulator at `127.0.0.1:8080`.
Unsetting `FIRESTORE_EMULATOR_HOST` can make a backend service use production
Firebase through Application Default Credentials, so check the environment
before running it.

For local development, the simplest setup is to copy
`services/agent-service/.env.example` to
`services/agent-service/.env` and put the key in that gitignored file. If you
prefer to supply it to one shell session, Bash syntax is:

```bash
export OPENAI_API_KEY="your-key"
npm run start:all
```

Or set it only for the launcher command:

```bash
OPENAI_API_KEY="your-key" npm run start:all
```

Do not commit the key, paste a real key into documentation, or expose it to the
browser.

The launcher builds the project, verifies or deploys the lab as needed, starts
the emulator and services, and manages cleanup when you press Ctrl+C. Logs are
retained under `.acn-runtime/logs/`. For a run without model calls or an API
key, use:

```bash
ACN_SKIP_AGENT=1 npm run start:all
```

See `npm run start:all -- --help` for supported launcher options. Follow the
README's individual-process instructions when you need to run or debug one
component separately.

## Configuration reference

Copy only the `.env.example` files for services you run independently. The
full annotated lists are in those files; this table highlights settings most
likely to affect local development. The managed `npm run start:all` launcher
sets the emulator host and project id for its child processes.

| Service or process | Variable | Default | Purpose |
| --- | --- | --- | --- |
| Backend services | `FIRESTORE_EMULATOR_HOST` | `127.0.0.1:8080` in local `.env.example` files | Sends Admin SDK operations to the local emulator. If unset, the SDK can use real Firebase credentials. |
| Backend services | `FIREBASE_PROJECT_ID` | `acn-local` | Selects the Firebase project id; use the local id for emulator development. |
| Backend services | `LOG_LEVEL` | `info` | Sets logging verbosity (`debug`, `info`, `warn`, or `error`). |
| Health Service | `HEALTH_CHECK_INTERVAL_SECONDS` | `30` | Seconds between health-check rounds. |
| Health Service | `HEALTH_CHECK_TIMEOUT_SECONDS` | `2` | Timeout for an individual ping. |
| Health Service | `HEALTH_CHECK_PING_COUNT` | `2` | Echo requests sent per device check; one successful reply is healthy. |
| Layer 0 | `LAYER_ZERO_FLUSH_INTERVAL_MS` | `500` | How long observations are buffered before batch writes. |
| Layer 0 | `LAYER_ZERO_RESTART_DELAY_MS` | `3000` | Delay before reconnecting a tail process that exited. |
| Layer 0 | `LAYER_ZERO_OBSERVER_INTERVAL_MS` | `5000` | Interval between read-only router-state probes. |
| Layer 0 | `DOCKER_BINARY` | `docker` | Docker command used for probes and log collection. |
| Incident Service | `INCIDENT_CORRELATION_WINDOW_MS` | `120000` | Window for grouping related events. |
| Incident Service | `INCIDENT_SETTLE_MS` | `10000` | Quiet period before a diagnosis is treated as settled. |
| Incident Service | `INCIDENT_TICK_INTERVAL_MS` | `2000` | Interval for reevaluating and persisting incident state. |
| Incident Service | `INCIDENT_REPLAY_HISTORY` | `false` | Whether to correlate existing Firestore events at startup. |
| Agent Service | `OPENAI_API_KEY` | No valid default | Server-side API credential. Keep it in the Agent Service `.env` or shell only. |
| Agent Service | `OPENAI_REASONING_EFFORT` | `low` | Model reasoning effort. |
| Agent Service | `OPENAI_TIMEOUT_MS` | `60000` | Model request timeout. |
| Agent Service | `OPENAI_MAX_OUTPUT_TOKENS` | `4096` | Maximum model output size. |
| Lab Controller | `LAB_CONTROLLER_HOST` | `127.0.0.1` | Bind address; keep the controller localhost-only. |
| Lab Controller | `LAB_CONTROLLER_PORT` | `8787` | Local HTTP port. |
| `start-all.sh` | `ACN_SKIP_AGENT` | `0` | Set to `1` to run without the Agent Service or API key. |
| `start-all.sh` | `ACN_SKIP_LAB` | `0` | Set to `1` to skip lab verification/deployment. |
| `start-all.sh` | `ACN_SKIP_BUILD` | `0` | Set to `1` to use existing `dist/` builds. |
| `start-all.sh` | `ACN_WEB_PORT` | First free port from `4200` upward | Selects the dashboard port. |
| `start-all.sh` | `ACN_OPEN_BROWSER` | `1` | Set to `0` to suppress automatic browser opening when `xdg-open` is available. |
| `start-all.sh` | `ACN_RUNTIME_DIR` | `<repo>/.acn-runtime` | Overrides the directory for launcher logs and its running lock. |

The launcher options are documented by `npm run start:all -- --help`; they
are not service `.env` settings. When changing a variable or its default,
update the corresponding `.env.example` and this summary if the setting is
developer-relevant.

## Find the right component

| Change | Start in | Component notes |
| --- | --- | --- |
| Device reachability, check classification, or transition behavior | `services/health-service/src/` | Tests are in `services/health-service/tests/`; see [data pipeline](./data-pipeline.md). |
| FRR parsing, event rules, log collection, or router-state observation | `services/layer-zero/src/` | [Layer 0 README](../services/layer-zero/README.md) |
| Event grouping, recovery, settle timing, or root-cause diagnosis | `services/incident-service/src/` | [incident model](./incident-model.md) |
| Evidence loading, prompt, structured output, or investigation lifecycle | `services/agent-service/src/` | [Agent Service README](../services/agent-service/README.md) |
| Fixed manual lab actions or their audit lifecycle | `services/lab-controller/src/` and `lab/scenarios/` | [Lab Controller README](../services/lab-controller/README.md) |
| Dashboard data, presentation, or manual controls | `apps/web/src/app/` | [web README](../apps/web/README.md) |
| Firestore record shape or query indexes | `docs/data-model.md`, `firebase/firestore.indexes.json`, and affected writers/readers | [data model](./data-model.md) |

Backend workspaces use TypeScript with strict checks, `noUncheckedIndexedAccess`,
and Node's test runner. Prefer the existing helpers and test patterns in the
component over adding parallel infrastructure.

## Common change workflows

### Add or change a Layer 0 event

1. Capture a representative line from the running lab; parser fixtures should
   use verbatim lab output, not an invented FRR message.
2. Keep envelope parsing in `normalize/parser.ts` and event meaning in
   `normalize/rules.ts`. A line that does not produce an event must still be
   retained as raw evidence.
3. Add or update focused tests in `services/layer-zero/tests/parser.test.ts`
   and/or `rules.test.ts`.
4. Run `npm test --workspace services/layer-zero`, then `npm run build`.
5. If the change affects the live monitoring flow, validate with
   `./scripts/e2e-layer-zero.sh` when the lab and emulator are available.

### Change health or incident behavior

For Health Service changes, start with the check, ping, and state-tracker tests
under `services/health-service/tests/`. The initial health observation seeds
state and must not create a phantom transition.

For incident changes, inspect the correlator and root-cause tests under
`services/incident-service/tests/`, and update [incident-model.md](./incident-model.md)
if correlation or recovery semantics change. Keep root-cause inference
deterministic. In particular, preserve the evidence rule that distinguishes a
link failure (both ends corroborate) from an unresponsive device (one end
reports while the peer is unreachable).

Run the affected workspace tests and `npm run build`. Use
`./scripts/e2e-incidents.sh` to validate the live incident flow; it exercises
the lab and is not a unit-test substitute.

### Change Agent Service behavior

Update the focused tests under `services/agent-service/tests/` along with
changes to evidence loading, prompt/schema validation, citations, or run
lifecycle. Keep the agent structurally read-only: it must not receive Docker,
SSH, `vtysh`, Lab Controller, or network-action capability. Never put its API
key in the web app.

`./scripts/e2e-agent.sh` exercises live investigations and calls the paid
OpenAI API. Run it only when that external call is intended and a valid key is
configured. Most development should use unit tests or
`ACN_SKIP_AGENT=1 npm run start:all`.

### Change the dashboard or manual lab controls

For dashboard changes, use the Angular workspace scripts:

```bash
npm run build --workspace web
npm run test --workspace web
```

The dashboard's Firestore access is read-only. Manual controls must continue to
send only a named scenario id to the localhost-only Lab Controller; they must
not become arbitrary command execution or an AI action path. Update controller
tests and the relevant [Lab Controller README](../services/lab-controller/README.md)
when changing an action or its lifecycle.

### Change Firestore data

Update [data-model.md](./data-model.md), the affected writer and every reader
(including the dashboard), and the relevant emulator rules or indexes when a
field, collection, or query changes. Backend services use the Admin SDK;
browser writes must remain denied. The current open client reads are safe only
for the local synthetic-data emulator and must not be deployed to a real
Firebase project as-is.

## Validation commands

From the repository root:

```bash
npm test
npm run build
npm run test --workspace web
```

The root `npm test` command runs backend unit tests; it does **not** run the
Angular tests, so run the web command separately when relevant. For focused
backend validation, substitute one workspace name, for example:

```bash
npm test --workspace services/layer-zero
```

Use this matrix to choose the smallest useful validation. Run end-to-end
commands only when their lab/emulator effects are acceptable:

| Change area | Focused unit tests | Broader verification | Requirements and effects |
| --- | --- | --- | --- |
| Health Service | `npm test --workspace services/health-service` | `./scripts/e2e-test.sh` | E2E needs Docker, a healthy lab, and Firestore emulator; it clears emulator data and breaks/restores the R2–R3 link. |
| Layer 0 collection/normalization | `npm test --workspace services/layer-zero` | `./scripts/e2e-layer-zero.sh` | E2E needs Docker, lab, and emulator; it clears emulator data and breaks/restores the link. |
| Incident correlation/diagnosis | `npm test --workspace services/incident-service` | `npm run test:e2e:failure-categories` for fast fixture coverage; `./scripts/e2e-incidents.sh` for live scenarios | Fixture E2E builds the relevant backend workspaces and uses no lab, emulator, or model API. Live E2E needs Docker, lab, and emulator; it clears emulator data and runs five lab fault/restore cycles. |
| Agent investigation | `npm test --workspace services/agent-service` | `./scripts/e2e-agent.sh` | Paid/live verification needs a valid `OPENAI_API_KEY`, Docker, lab, and emulator. It invokes the incident E2E first (clearing emulator data and running lab scenarios), then makes model calls. |
| Lab Controller | `npm test --workspace services/lab-controller` | Exercise named controls in the running local stack | Live controls change the synthetic lab and write action records to emulator `labActions/`. |
| Angular dashboard | `npm run test --workspace web` | `npm run build --workspace web`; inspect in the running stack for behavior changes | Angular tests use the configured Karma/browser runner; live dashboard data requires the emulator and backend stack. |
| Cross-workspace TypeScript | — | `npm run build` | Compiles all configured workspaces; no lab or emulator required. |

The root `npm test` command runs backend unit tests; it does **not** run the
Angular tests, so run the web command separately when relevant. The
failure-category fixture test is available as
`npm run test:e2e:failure-categories`; it builds its backend dependencies and
does not call the model API.

The live end-to-end scripts reset Firestore emulator data and alter the lab.
Stop other ACN services that may write to the same emulator before running
them. Read the script prerequisites and [PROGRESS.md](../PROGRESS.md) before
starting; do not point them at production Firebase or infrastructure/data you
need to preserve.

If changing one service's persisted fields or behavior, run its focused tests
first, then the build; run an end-to-end scenario when the change crosses
service boundaries. Avoid running reset or destructive lab commands against
data or infrastructure you need to keep. `./scripts/reset-firestore.sh` wipes
the emulator's data.

## Local lab and troubleshooting

- **First establish which layer is failing.** Confirm emulator availability,
  lab connectivity, and running service processes before changing configs or
  redeploying:

  ```bash
  curl -sf http://127.0.0.1:8080/ >/dev/null && echo "Firestore emulator responds"
  ./lab/verify.sh
  ps -eo pid,args | grep -E 'dist/index.js|tsx' | grep -v grep
  ```

  `lab/verify.sh` checks network reachability. If it fails, investigate the
  lab and host routes before debugging event processing. If reachability is
  good but Firestore records are absent, check the emulator and the relevant
  service log under `.acn-runtime/logs/` (or the terminal running that service).
- **If the lab fails after a host reboot**, containers may be running without
  Containerlab's data-plane interfaces or the host routes. Stop any running
  stack before repairing topology. Follow the exact recovery procedure in
  [PROGRESS.md](../PROGRESS.md); reconfiguring the topology recreates links,
  and restoring host routes requires interactive sudo.
- **If router logs are missing**, do not rely on `docker logs`; FRR daemonizes.
  Check Layer 0's log-tail output and the FRR file/permission constraints in
  [Layer 0's README](../services/layer-zero/README.md). Raw lines are persisted
  even when no normalization rule recognizes them, so distinguish missing
  collection from an unrecognized event.
- **If events or incidents appear duplicated**, inspect for stray service
  processes before rerunning tests. A second Health or Incident Service can
  keep writing or race on the same incident ids. Prefer `npm run start:all`
  for the interactive stack and use the lifecycle helpers in
  `scripts/lib/services.sh` for e2e scripts; do not kill only an `npx`/`tsx`
  wrapper.
- **If an E2E restore check fails**, verify the host routes as described in
  [PROGRESS.md](../PROGRESS.md). `06-restore-network.sh` checks reachability
  from the host, so missing routes can fail its convergence check even when
  router containers are running.
- **If Firestore data is unexpectedly empty**, check whether an E2E script
  reset it. The e2e scripts intentionally clear emulator state before running.
- **If the dashboard or controller port is unavailable**, check the launcher
  output and logs. The dashboard can select a free port starting at 4200;
  the Lab Controller uses 8787 and must remain bound to `127.0.0.1`.
- **Docker access can be stale in an existing shell.** After adding a user to
  the Docker group, start a new login session and verify group access before
  running lab tools. Do not assume a running process inherited newly granted
  membership.
- **Keep test data local.** Backend services use production Firebase if the
  emulator environment variable is absent. Confirm emulator configuration
  before starting a service or running a script.

## Documentation ownership

- [PROGRESS.md](../PROGRESS.md) — current implementation status, next increment,
  verified results, and environment traps.
- [FunctionDiagrams.md](./FunctionDiagrams.md) — component responsibilities,
  implemented service flows, dashboard flow, planned action boundary, and code
  references.
- [architecture.md](./architecture.md) and [data-pipeline.md](./data-pipeline.md) —
  architecture decisions and end-to-end data movement.
- [data-model.md](./data-model.md) and [incident-model.md](./incident-model.md) —
  Firestore shapes and incident semantics.
- Component READMEs — local behavior and component-specific operation notes.

When behavior changes, update the directly related tests and documentation in
the same change. Keep planned increments clearly labeled as planned; do not
document them as implemented before they exist.
