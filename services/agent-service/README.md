# GPT read-only investigation agent

Increment 4 investigates deterministic `incidents/` with GPT-5.6 Luna. It
reads the incident, every referenced `networkEvents/` document and the original
`networkLogs/` lines behind log-derived events, then records a reproducible run
in `agentRuns/`.

The service is deliberately read-only with respect to the network. It has no
Docker, SSH, `vtysh`, controller or remediation capability.

## Model contract

The model is hard-pinned to `gpt-5.6-luna` through the OpenAI Responses API,
with low reasoning effort, strict structured JSON output and response storage
disabled. The pricing snapshot stored on completed runs follows the official
[GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna):
$0.20 per million input tokens, $0.02 cached input, $0.25 cache writes and
$1.20 output. See the official [GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
for the reasoning-effort and prompting guidance behind the low-latency default.

## Run locally

```bash
cp services/agent-service/.env.example services/agent-service/.env
# Add your OPENAI_API_KEY to that gitignored file.
npm run agent-service
```

The Firestore emulator must already be running. The service investigates each
settled diagnosis once; changing or adding telemetry does not create another
paid run unless the deterministic root-cause diagnosis itself changes.

If the key is missing, invalid, rate-limited or the API times out, the service
records a failed `agentRuns/` document and continues watching. It never allows
an AI or database failure to propagate into the Health, Layer 0 or Incident
services.
