# Increment 5 — evidence-first GPT root-cause evaluation

## Goal

Make GPT produce the primary root-cause hypothesis from neutral network evidence,
then compare that committed answer with lab-only ground truth that was never
included in the model prompt.

## Trust boundaries

1. **Observation:** health and Layer Zero services continue to detect and store
   live network facts autonomously.
2. **Investigation:** Agent Service projects stored events into neutral
   observations and supplies those observations plus raw device logs to GPT.
   Deterministic root cause, incident symptoms, scenario names and controller
   output are excluded.
3. **Ground truth:** the localhost-only lab controller records the expected cause
   and device set in a separate `labEvaluations` collection. Direct invocation of
   a scenario script creates no evaluation record.
4. **Evaluation:** only after GPT returns a valid, cited conclusion does Agent
   Service load the associated ground truth, score cause type and device set
   independently, and publish the comparison on the completed run.
5. **Production behavior:** when no lab evaluation is associated, the GPT
   diagnosis is stored normally and the run is explicitly marked unscored.

## Implementation slices

- Add ground-truth metadata to the five failure definitions and persist a
  pending lab evaluation only after successful injection. Restore and failed
  actions do not create ground truth.
- Atomically associate at most one pending evaluation with the next new agent
  run, using only an opaque evaluation ID during investigation.
- Add a neutral evidence projection with an allow-list of factual attributes.
  Remove event types, symptoms, deterministic diagnosis and predicted impact
  from the prompt. Version the prompt as v3.
- Persist structured evaluation results after the conclusion is committed:
  `typeMatch`, `devicesMatch`, and `overallMatch`. Keep unscored runs explicit.
- Update the dashboard to show **Lab ground truth** beside **GPT diagnosis** only
  for completed scored runs.
- Add unit, integration and focused end-to-end tests for prompt leakage,
  successful/failed/restore actions, atomic claiming, scoring, missing truth,
  recovery evidence, ambiguous/unknown evidence, and exact citation integrity.

## Exit criteria

- No serialized GPT prompt contains a deterministic root cause, incident
  symptom, scenario label, controller output, or cause-revealing event type.
- All five lab scenarios can produce blind, scored GPT evaluations.
- A run without controller-created truth remains a valid unscored diagnosis.
- Ground truth is not present on a running/analyzing `agentRuns` document.
- Existing autonomous detection, incident lifecycle and topology prediction
  tests continue to pass.
