# ACN NOC dashboard

Read-only live view of Increments 1 to 3, in Angular.

```bash
npm run emulators        # Firestore on :8080
npm run health-service   # ICMP -> devices, healthChecks, networkEvents
npm run layer-zero       # FRR logs -> networkLogs, networkEvents
npm run incident-service # networkEvents -> incidents
npm run web              # this app on http://localhost:4200
```

## Scope

**This is pulled forward from Increment 7 deliberately, and kept small.** The
full NOC UI — authentication, per-user authorisation, incident acknowledgement,
agent interaction — is still Increment 7. What exists here is a viewer, added
because a correlation engine you cannot watch working is hard to trust.

It renders, top to bottom, the path the data takes:

- **Network** — the five lab devices in physical cabling order
  (`PC1—R1—R2—R3—PC2`), each showing its latest ICMP result. Laid out as the
  actual chain rather than an alphabetical list, so a partial outage is visible
  in place: break R2–R3 and the right-hand half goes red.
- **Incidents** — what the correlator concluded and why. Expanding one shows the
  verdict, the evidence in plain language, the predicted-vs-observed check, the
  symptoms, and every event behind it.
- **Normalized events** — the live stream from both producers, tagged `ICMP` or
  `LOG` by which layer emitted it.

The evidence trail is the point. Each log-derived event shows the exact raw FRR
line it was normalized from, resolved through `sourceLogId`, so a claim like
"R2 <-> R3 link failure" can be followed all the way down to the text a router
actually emitted without leaving the page.

## It talks to the emulator, on purpose

A browser app connects to the Firestore emulator exactly as it would to a real
project — same SDK, same queries, same live `onSnapshot` listeners. Nothing
about this UI has to change when a real Firebase project arrives in
Increment 10. Meanwhile the repo needs no credentials, the data stays
disposable, and `./scripts/reset-firestore.sh` keeps working.

Connection settings are in [src/app/firebase.ts](src/app/firebase.ts).

## Security

Strictly read-only. `firebase/firestore.rules` denies every client write —
nothing in a browser has any business changing observed network state — and all
writes come from backend services using the Admin SDK.

Reads are currently open, which is safe *only* because this runs against a
local emulator holding synthetic lab data. **Those rules must not be deployed to
a real project as they stand.** Increment 7 adds Firebase Auth and replaces
`allow read: if true` with per-user authorisation.

## Live updating

Everything is an `onSnapshot` listener, so the page reacts to the lab rather
than polling. Run the scenarios in a terminal and watch:

```bash
./lab/scenarios/01-link-failure.sh     # incident appears within a check interval
./lab/scenarios/03-restore-network.sh  # incident resolves
```

`healthChecks`, `networkLogs` and `networkEvents` are append-only and unbounded,
so each listener reads a recent slice rather than the whole history. An incident
older than that slice shows fewer events than its `eventCount`, and says so.
