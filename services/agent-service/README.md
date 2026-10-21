# GPT evidence investigator

Increments 4–5 investigate `incidents/` with GPT-5.6 Luna. The service reads the
incident, every referenced `networkEvents/` document and the original
`networkLogs/` lines behind log-derived events, then records a reproducible run
in `agentRuns/`. A prompt-only projection removes the deterministic diagnosis,
incident symptoms and cause-revealing event names. GPT sees neutral facts and
raw device evidence; lab-only ground truth is loaded and scored only after the
model returns a valid cited conclusion.

For a controller-triggered evaluation, the service atomically claims at most
one pending record by its opaque id. Expected values are not copied into the
running agent record or prompt; after response validation, the service scores
cause type, device set and proposed repair tool on the completed run.

The service is deliberately read-only with respect to the network. It has no
Docker, SSH, `vtysh`, controller or remediation capability. Its typed repair
proposal is inert data; the separate Network Controller validates the completed
run and citations, then requires a human approval before a fixed repair can run.

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

The Firestore emulator must already be running. The service performs one paid
investigation per settled evidence revision and prompt contract. It ignores
legacy or unsettled incidents, transactionally verifies readiness while claiming,
and reloads the incident and evidence before GPT is invoked. Duplicate callbacks
and concurrent service instances converge on the same deterministic run id.
Run identity does not depend on the deterministic root-cause mapper.

If the key is missing, invalid, rate-limited or the API times out, the service
records a failed `agentRuns/` document and continues watching. It never allows
an AI or database failure to propagate into the Health, Layer 0 or Incident
services.
