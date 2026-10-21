# ACN NOC dashboard

Live operator view of telemetry, GPT investigations, and human-authorized
guarded repairs, in Angular.

Start the complete stack with one command:

```bash
npm run start:all
```

The launcher chooses an available dashboard port, prints the resulting URL and
keeps individual logs in `.acn-runtime/logs/`. Ctrl+C stops everything it
started. The commands below remain useful for running components separately.

```bash
npm run emulators        # Firestore on :8080
npm run health-service   # ICMP -> devices, healthChecks, networkEvents
npm run layer-zero       # FRR logs -> networkLogs, networkEvents
npm run incident-service # networkEvents -> incidents
npm run agent-service    # incidents + evidence -> agentRuns
npm run lab-controller   # five whitelisted faults plus restore on :8787
npm run network-controller # guarded repair API on :8788
npm run web              # this app on http://localhost:4200
```

## Scope

The dashboard visualizes the live telemetry and investigation flow, manual
synthetic-lab controls, and Increment 6's guarded repair workflow. Production
authentication, per-user authorization, and incident acknowledgement remain
future work; this is a local operator tool, not a production NOC.

It renders, top to bottom, the path the data takes:

- **Network** — the five lab devices in physical cabling order
  (`PC1—R1—R2—R3—PC2`), each showing its latest ICMP result. Laid out as the
  actual chain rather than an alphabetical list, so a partial outage is visible
  in place: break R2–R3 and the right-hand half goes red.
- **Manual fault controls** — invoke one of the Lab Controller's fixed
  fault-injection scenarios or restore the network through its localhost-only
  API. The browser can select a named scenario but cannot supply a command,
  path, device or interface.
- **Live operations timeline** — health checks, raw FRR lines, normalized
  events, incident state, lab-controller output and Luna results merged by
  time, with problem, AI and raw-log filters.
- **Incidents** — what the correlator concluded and why. Expanding one shows the
  verdict, the evidence in plain language, the predicted-vs-observed check, the
  symptoms, and every event behind it.
- **GPT investigator** — the `collecting evidence` and `analyzing` lifecycle,
  Luna's independent conclusion, cited events and raw logs, tokens, latency,
  cost and the exact reproduction prompt. Lab ground truth is withheld from
  the prompt and shown only for post-response evaluation. A typed repair
  proposal is displayed as a recommendation, not an executed action.
- **Human-authorized repair** — inspect the validated proposal, citations,
  risk, audit history and observed outcome; approve a named fixed repair or
  reject it with a reason. Approval is required before the Network Controller
  runs its code-owned adapter. Success is reported only after fresh observer
  evidence and incident resolution.
- **Normalized events** — the live stream from both producers, tagged `ICMP` or
  `LOG` by which layer emitted it.

The evidence trail is the point. Each log-derived event shows the exact raw FRR
line it was normalized from, resolved through `sourceLogId`, so a claim like
"R2 <-> R3 link failure" can be followed all the way down to the text a router
actually emitted without leaving the page.

## It talks to the emulator, on purpose

A browser app connects to the Firestore emulator with the Firebase SDK, queries
and live `onSnapshot` listeners used for Firebase. Moving beyond the local
emulator still requires production configuration and the authentication and
authorization work described above. The repo needs no Firebase credentials for
local development, the data stays disposable, and `./scripts/reset-firestore.sh`
keeps working.

Connection settings are in [src/app/firebase.ts](src/app/firebase.ts).

## Security

Firestore access from the browser remains read-only.
`firebase/firestore.rules` denies every client write; database writes are made
by backend services using the Admin SDK. Manual fault controls call
`127.0.0.1:8787`, the Lab Controller's fixed scenario interface, and write
their output to `labActions/`. Approval/rejection calls the separate
`127.0.0.1:8788` Network Controller, which accepts a named decision—not a
shell command—and validates the proposal before execution. GPT cannot call
either controller; only the Network Controller can invoke its fixed repair
adapters after a recorded human approval.

Reads are currently open, and the controller APIs are local-development
interfaces without production identity/authorization. This is safe only for
the local emulator and synthetic lab. **Do not deploy these rules or expose
these APIs to a real network.** Production Firebase Auth, per-user
authorization, and controller access control remain future work.

## Live updating

Everything is an `onSnapshot` listener, so the page reacts to the lab rather
than polling. Run the scenarios in a terminal and watch:

```bash
./lab/scenarios/03-interface-disabled.sh # incident appears within a check interval
./lab/scenarios/06-restore-network.sh    # incident resolves
```

`healthChecks`, `networkLogs` and `networkEvents` are append-only and unbounded,
so each listener reads a recent slice rather than the whole history. An incident
older than that slice shows fewer events than its `eventCount`, and says so.
