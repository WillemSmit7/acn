import { Component, effect, inject, input, untracked } from '@angular/core';
import { CitedEvidenceService } from '../cited-evidence.service';
import type { AgentRun } from '../models';

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
              [class.failed]="run.status === 'failed'">
            <div class="head">
              <div class="identity">
                <span class="run-id">{{ run.runId }}</span>
                <span class="incident">{{ run.incidentId }}</span>
              </div>
              <div class="badges">
                <span class="stage" [class.pulse]="run.status === 'running'">
                  {{ stage(run) }}
                </span>
                @if (run.conclusion; as conclusion) {
                  <span class="agreement">{{ conclusion.confidence }} confidence</span>
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
                <div class="diagnosis">
                  <h4>Diagnosis</h4>
                  <strong>{{ conclusion.summary }}</strong>
                  <span class="confidence">{{ conclusion.confidence }} confidence — model assessment, not a verified probability</span>
                  <span class="confidence">Suspected cause: {{ label(conclusion.rootCauseType) }} · {{ conclusion.rootCauseDevices.join(', ') || 'device undetermined' }}</span>
                  <h4>Proposed repair</h4>
                  <strong>{{ label(conclusion.remediationProposal.tool) }}</strong>
                  <p>{{ conclusion.remediationProposal.rationale }}</p>
                </div>

                <h4>Reasoning</h4>
                <ul class="reasoning">
                  @for (line of conclusion.reasoning; track line) { <li>{{ line }}</li> }
                </ul>

                <h4>Cited evidence</h4>
                <div class="citations">
                  @if (eventIds(run).length === 0 && logIds(run).length === 0) {
                    <p class="none">No evidence was cited for this diagnosis.</p>
                  }
                  @for (eventId of eventIds(run); track eventId) {
                    @let record = evidence.state('networkEvents', eventId);
                    <details>
                      <summary>Event <code>{{ eventId }}</code></summary>
                      @if (record?.data; as event) {
                        <div class="event-meta">{{ event['deviceId'] }} · {{ event['eventType'] }} · source {{ event['source'] || 'unavailable' }} · occurred {{ evidence.timestamp(event['occurredAt']) }}</div>
                        <h4>Metrics and attributes</h4>
                        <pre class="raw">{{ evidence.format(event['attributes']) }}</pre>
                        @if (event['sourceLogId']; as sourceLogId) {
                          @let sourceRecord = evidence.state('networkLogs', sourceLogId);
                          <div class="event-meta">Originating log <code>{{ sourceLogId }}</code></div>
                          @if (sourceRecord?.data; as log) {
                            <div class="event-meta">{{ log['deviceId'] }} · {{ log['source'] || 'source unavailable' }} · {{ log['daemon'] || 'daemon unavailable' }} · received {{ evidence.timestamp(log['receivedAt']) }}</div>
                            <pre class="raw">{{ log['raw'] }}</pre>
                          } @else {
                            <span class="none">{{ evidenceMessage(sourceRecord) }}</span>
                            @if (sourceRecord?.status === 'error' || sourceRecord?.status === 'missing') {
                              <button type="button" (click)="evidence.retry('networkLogs', sourceLogId)">Retry log</button>
                            }
                          }
                        } @else {
                          <span class="none">No originating device log is recorded for this observation.</span>
                        }
                      } @else {
                        <span class="none">{{ evidenceMessage(record) }}</span>
                        @if (record?.status === 'error' || record?.status === 'missing') {
                          <button type="button" (click)="evidence.retry('networkEvents', eventId)">Retry event</button>
                        }
                      }
                    </details>
                  }
                  @for (logId of logIds(run); track logId) {
                    @let record = evidence.state('networkLogs', logId);
                    <details>
                      <summary>Log <code>{{ logId }}</code></summary>
                      @if (record?.data; as log) {
                        <div class="event-meta">{{ log['deviceId'] }} · source {{ log['source'] || 'unavailable' }} · {{ log['daemon'] || 'daemon unavailable' }} · received {{ evidence.timestamp(log['receivedAt']) }}</div>
                        <pre class="raw">{{ log['raw'] }}</pre>
                      } @else {
                        <span class="none">{{ evidenceMessage(record) }}</span>
                        @if (record?.status === 'error' || record?.status === 'missing') {
                          <button type="button" (click)="evidence.retry('networkLogs', logId)">Retry log</button>
                        }
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
                    <pre class="acn-scroll">{{ run.prompt.developer }}\n\n{{ run.prompt.input }}</pre>
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
    @keyframes pulse { 50% { opacity: 0.45; } }
    .model { margin-top: 0.25rem; color: var(--muted); font: 0.68rem var(--mono); }
    .working-copy, .error { margin: 0.65rem 0 0; font-size: 0.84rem; }
    .error { color: var(--bad); }
    .diagnosis { margin-top: 0.8rem; padding: 0.65rem;
      border-radius: 6px; background: var(--panel);
    }
    h4 {
      margin: 0.8rem 0 0.3rem; color: var(--muted); font-size: 0.67rem;
      text-transform: uppercase; letter-spacing: 0.07em;
    }
    .diagnosis h4 { margin-top: 0; }
    .diagnosis strong { display: block; font-size: 0.88rem; }
    .confidence { display: block; color: var(--muted); margin-top: 0.2rem; font-size: 0.68rem; }
    .reasoning { padding-left: 1.1rem; list-style: disc; }
    .reasoning li { margin: 0.15rem 0; font-size: 0.82rem; }
    .citations details, .prompt { border-top: 1px solid var(--line); padding: 0.35rem 0; }
    summary { cursor: pointer; font-size: 0.76rem; }
    summary code { color: var(--accent); font-family: var(--mono); }
    .event-meta, .none { display: block; color: var(--muted); font-size: 0.7rem; margin: 0.35rem 0; }
    .raw {
      display: block; padding: 0.45rem; overflow-wrap: anywhere; white-space: pre-wrap; border-radius: 4px;
      color: var(--muted); background: var(--bg); font: 0.7rem var(--mono);
    }
    .metrics { margin-top: 0.7rem; color: var(--muted); font: 0.68rem var(--mono); }
    .metrics span + span::before { content: '·'; margin-right: 0.55rem; }
    .prompt { margin-top: 0.6rem; }
    .prompt pre {
      max-height: 18rem; overflow: auto; white-space: pre-wrap; padding: 0.55rem;
      color: var(--muted); background: var(--bg); font: 0.67rem var(--mono);
    }
  `],
})
export class AgentRunsComponent {
  readonly runs = input.required<AgentRun[]>();

  label(value: string): string {
    return value.replaceAll('_', ' ');
  }
  readonly evidence = inject(CitedEvidenceService);

  constructor() {
    effect(() => {
      const runs = this.runs();
      untracked(() => {
        for (const run of runs) {
          for (const id of this.eventIds(run)) this.evidence.ensure('networkEvents', id);
          for (const id of this.logIds(run)) this.evidence.ensure('networkLogs', id);
        }
      });
    });
  }

  eventIds(run: AgentRun): string[] {
    return [...new Set([...run.citedEventIds, ...(run.conclusion?.citedEventIds ?? [])])];
  }

  logIds(run: AgentRun): string[] {
    return [...new Set([...run.citedLogIds, ...(run.conclusion?.citedLogIds ?? [])])];
  }

  evidenceMessage(record: { status: string; error?: string } | undefined): string {
    if (record?.status === 'missing') return 'Cited document is missing from the evidence store.';
    if (record?.status === 'error') return `Could not read cited evidence: ${record.error}`;
    return 'Loading cited evidence…';
  }

  stage(run: AgentRun): string {
    return run.stage.replaceAll('_', ' ');
  }

  cost(run: AgentRun): string {
    return run.estimatedCostUsd === null ? 'cost pending' : `$${run.estimatedCostUsd.toFixed(6)}`;
  }
}
