import { Component, inject, input } from '@angular/core';
import { DataService } from '../data.service';
import type { AgentRun, NetworkEvent, NetworkLog } from '../models';

/** Live, read-only view of GPT's investigation lifecycle and cited evidence. */
@Component({
  selector: 'acn-agent-runs',
  standalone: true,
  template: `
    @if (runs().length === 0) {
      <p class="empty">
        No investigations yet. Start the Agent Service:
        <code>npm run agent-service</code>
      </p>
    } @else {
      <ul class="runs">
        @for (run of runs(); track run.id) {
          <li [class.working]="run.status === 'running'"
              [class.failed]="run.status === 'failed'"
              [class.disagree]="run.agreement === 'disagree'">
            <div class="head">
              <div class="identity">
                <span class="run-id">{{ run.runId }}</span>
                <span class="incident">{{ run.incidentId }}</span>
              </div>
              <div class="badges">
                <span class="stage" [class.pulse]="run.status === 'running'">
                  {{ stage(run) }}
                </span>
                @if (run.agreement) {
                  <span class="agreement" [class.no]="run.agreement === 'disagree'">
                    {{ run.agreement === 'agree' ? 'ground-truth match' : 'ground-truth mismatch' }}
                  </span>
                }
              </div>
            </div>

            <div class="model">{{ run.model }} · reasoning {{ run.reasoningEffort }}</div>

            @if (run.status === 'running') {
              <p class="working-copy">
                {{ run.stage === 'collecting_evidence'
                  ? 'Following incident references into normalized events and raw device logs…'
                  : 'Luna is independently evaluating the evidence…' }}
              </p>
            } @else if (run.status === 'failed') {
              <p class="error">Investigation failed: {{ run.error ?? 'unknown error' }}</p>
            } @else {
              @if (run.conclusion; as conclusion) {
                <div class="comparison">
                <div>
                  <h4>Lab ground truth</h4>
                  @if (run.labGroundTruth; as truth) {
                    <strong>{{ label(truth.rootCauseType) }}</strong>
                    <span class="confidence">{{ truth.rootCauseDevices.join(', ') || 'no device' }}</span>
                    <span class="confidence">known repair: {{ label(truth.expectedRemediationTool) }}</span>
                  } @else {
                    <strong>Unscored production-style run</strong>
                    <span class="confidence">No controller-created truth was associated</span>
                  }
                </div>
                <span class="arrow">→</span>
                <div>
                  <h4>GPT investigation</h4>
                  <strong>{{ conclusion.summary }}</strong>
                  <span class="confidence">{{ conclusion.confidence }} confidence</span>
                  <span class="confidence">
                    GPT repair guess: {{ label(conclusion.remediationProposal.tool) }}
                  </span>
                </div>
                </div>

                @if (run.evaluation; as evaluation) {
                  <div class="metrics evaluation">
                    <span>{{ evaluation.typeMatch ? '✓' : '✕' }} cause type</span>
                    <span>{{ evaluation.devicesMatch ? '✓' : '✕' }} device set</span>
                    <span>
                      {{ evaluation.remediationMatch ? '✓ GPT repair guess correct' : '✕ GPT repair guess incorrect' }}
                    </span>
                  </div>
                }

                <h4>Reasoning</h4>
                <ul class="reasoning">
                  @for (line of conclusion.reasoning; track line) { <li>{{ line }}</li> }
                </ul>

                <h4>Cited evidence</h4>
                <div class="citations">
                  @for (eventId of run.citedEventIds; track eventId) {
                    @let event = eventFor(eventId);
                    <details>
                      <summary>
                        <code>{{ eventId }}</code>
                        @if (event) { — {{ event.deviceId }} {{ event.eventType }} }
                      </summary>
                      @if (event) {
                        <div class="event-meta">
                          {{ event.source }} · {{ time(event.occurredAt) }}
                        </div>
                        @let raw = rawFor(event);
                        @if (raw) {
                          <code class="raw">{{ raw.raw }}</code>
                        } @else {
                          <span class="none">ICMP observation — no originating device log</span>
                        }
                      } @else {
                        <span class="none">Event is outside the dashboard's recent window.</span>
                      }
                    </details>
                  }
                </div>

                <div class="metrics">
                  <span>{{ run.totalTokens }} tokens</span>
                  <span>{{ run.latencyMs ?? 0 }} ms</span>
                  <span>{{ cost(run) }}</span>
                  <span>{{ run.evidenceEventIds.length }} events inspected</span>
                  <span>{{ run.evidenceLogIds.length }} logs inspected</span>
                </div>

                @if (run.prompt) {
                  <details class="prompt">
                    <summary>Reproduction prompt · {{ run.promptVersion }}</summary>
                    <pre>{{ run.prompt.developer }}\n\n{{ run.prompt.input }}</pre>
                  </details>
                }
              }
            }
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    .empty { color: var(--muted); font-size: 0.85rem; }
    .empty code { color: var(--accent); font-family: var(--mono); }
    .runs, .reasoning { list-style: none; margin: 0; padding: 0; }
    .runs > li {
      padding: 0.8rem; margin-bottom: 0.6rem; border: 1px solid var(--line);
      border-left: 3px solid var(--ok); border-radius: 8px; background: var(--panel-2);
    }
    .runs > li.working { border-left-color: var(--accent); }
    .runs > li.failed { border-left-color: var(--bad); }
    .runs > li.disagree { border-left-color: var(--warn); }
    .head, .identity, .badges, .metrics {
      display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap;
    }
    .head { justify-content: space-between; }
    .run-id { font: 600 0.78rem var(--mono); }
    .incident { color: var(--muted); font: 0.72rem var(--mono); }
    .stage, .agreement {
      padding: 0.14rem 0.45rem; border-radius: 999px; font-size: 0.64rem;
      text-transform: uppercase; letter-spacing: 0.06em; color: var(--ok); background: var(--ok-bg);
    }
    .stage.pulse { color: var(--accent); background: #12283a; animation: pulse 1.25s infinite; }
    .agreement.no { color: var(--warn); background: #312613; }
    @keyframes pulse { 50% { opacity: 0.45; } }
    .model { margin-top: 0.25rem; color: var(--muted); font: 0.68rem var(--mono); }
    .working-copy, .error { margin: 0.65rem 0 0; font-size: 0.84rem; }
    .error { color: var(--bad); }
    .comparison {
      display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.8rem;
      align-items: center; margin-top: 0.8rem; padding: 0.65rem;
      border-radius: 6px; background: var(--panel);
    }
    h4 {
      margin: 0.8rem 0 0.3rem; color: var(--muted); font-size: 0.67rem;
      text-transform: uppercase; letter-spacing: 0.07em;
    }
    .comparison h4 { margin-top: 0; }
    .comparison strong { display: block; font-size: 0.88rem; }
    .arrow { color: var(--muted); }
    .confidence { display: block; color: var(--muted); margin-top: 0.2rem; font-size: 0.68rem; }
    .reasoning { padding-left: 1.1rem; list-style: disc; }
    .reasoning li { margin: 0.15rem 0; font-size: 0.82rem; }
    .citations details, .prompt { border-top: 1px solid var(--line); padding: 0.35rem 0; }
    summary { cursor: pointer; font-size: 0.76rem; }
    summary code { color: var(--accent); font-family: var(--mono); }
    .event-meta, .none { display: block; color: var(--muted); font-size: 0.7rem; margin: 0.35rem 0; }
    code.raw {
      display: block; padding: 0.45rem; overflow-wrap: anywhere; border-radius: 4px;
      color: var(--muted); background: var(--bg); font: 0.7rem var(--mono);
    }
    .metrics { margin-top: 0.7rem; color: var(--muted); font: 0.68rem var(--mono); }
    .metrics span + span::before { content: '·'; margin-right: 0.55rem; }
    .prompt { margin-top: 0.6rem; }
    .prompt pre {
      max-height: 18rem; overflow: auto; white-space: pre-wrap; padding: 0.55rem;
      color: var(--muted); background: var(--bg); font: 0.67rem var(--mono);
    }
    @media (max-width: 700px) {
      .comparison { grid-template-columns: 1fr; }
      .arrow { transform: rotate(90deg); }
    }
  `],
})
export class AgentRunsComponent {
  readonly runs = input.required<AgentRun[]>();

  label(value: string): string {
    return value.replaceAll('_', ' ');
  }
  private readonly data = inject(DataService);

  stage(run: AgentRun): string {
    return run.stage.replace('_', ' ');
  }

  eventFor(id: string): NetworkEvent | undefined {
    return this.data.eventFor(id);
  }

  rawFor(event: NetworkEvent): NetworkLog | undefined {
    return this.data.logFor(event.sourceLogId);
  }

  time(value: Date | null): string {
    return value === null ? '--:--:--' : value.toTimeString().slice(0, 8);
  }

  cost(run: AgentRun): string {
    return run.estimatedCostUsd === null ? 'cost pending' : `$${run.estimatedCostUsd.toFixed(6)}`;
  }
}
