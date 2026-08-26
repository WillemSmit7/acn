import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { LabControlService, type ScenarioId } from '../lab-control.service';
import type {
  AgentRun,
  HealthCheck,
  Incident,
  LabAction,
  NetworkEvent,
  NetworkLog,
} from '../models';

type Filter = 'all' | 'problems' | 'ai' | 'raw';
type Tone = 'normal' | 'good' | 'warn' | 'bad' | 'ai';

interface TimelineEntry {
  id: string;
  at: Date | null;
  source: string;
  title: string;
  detail: string;
  tone: Tone;
  problem: boolean;
}

@Component({
  selector: 'acn-operations-console',
  standalone: true,
  template: `
    <div class="controls">
      <div class="control-head">
        <div>
          <h3>Manual fault controls</h3>
          <p>Whitelisted local-lab scenarios. Luna remains read-only.</p>
        </div>
        <span class="controller" [class.up]="control.connected()">
          <span class="dot"></span>
          {{ control.connected() ? (control.busy() ? 'action running' : 'controller ready') : 'controller offline' }}
        </span>
      </div>

      <div class="scenario-grid">
        @for (scenario of control.scenarios(); track scenario.id) {
          <button
            [class.restore]="scenario.tone === 'restore'"
            [disabled]="control.busy() || control.sending() !== null"
            (click)="trigger(scenario.id, scenario.label)">
            <strong>{{ control.sending() === scenario.id ? 'Starting…' : scenario.label }}</strong>
            <span>{{ scenario.description }}</span>
          </button>
        }
      </div>

      @if (control.error(); as message) {
        <p class="control-error">{{ message }} — start it with <code>npm run lab-controller</code></p>
      }

      @if (actions()[0]; as action) {
        <div class="last-action" [class.failed]="action.status === 'failed'">
          <span class="action-status">{{ action.status }}</span>
          <strong>{{ action.label }}</strong>
          @if (action.output.length > 0) {
            <code>{{ action.output[action.output.length - 1] }}</code>
          }
          @if (action.error) { <span class="action-error">{{ action.error }}</span> }
        </div>
      }
    </div>

    <div class="timeline-head">
      <div>
        <h3>Live operations timeline</h3>
        <p>Health → device logs → events → incident → Luna</p>
      </div>
      <div class="filters" aria-label="Timeline filter">
        @for (option of filterOptions; track option.id) {
          <button [class.active]="filter() === option.id" (click)="filter.set(option.id)">
            {{ option.label }}
          </button>
        }
      </div>
    </div>

    @if (visibleEntries().length === 0) {
      <p class="empty">Waiting for live telemetry…</p>
    } @else {
      <ol class="timeline">
        @for (entry of visibleEntries(); track entry.id) {
          <li [class]="entry.tone">
            <time>{{ time(entry.at) }}</time>
            <span class="source">{{ entry.source }}</span>
            <div>
              <strong>{{ entry.title }}</strong>
              @if (entry.detail) { <span>{{ entry.detail }}</span> }
            </div>
          </li>
        }
      </ol>
    }
  `,
  styles: [`
    h3 { margin: 0; font-size: 0.9rem; }
    p { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.74rem; }
    .controls { padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
    .control-head, .timeline-head {
      display: flex; justify-content: space-between; align-items: center;
      gap: 1rem; flex-wrap: wrap;
    }
    .controller { color: var(--muted); font: 0.68rem var(--mono); }
    .dot { display: inline-block; width: 0.45rem; height: 0.45rem; margin-right: 0.3rem;
      border-radius: 50%; background: var(--bad); }
    .controller.up .dot { background: var(--ok); }
    .scenario-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; margin-top: 0.75rem; }
    .scenario-grid button {
      padding: 0.65rem; border: 1px solid #663244; border-radius: 7px;
      color: var(--text); background: var(--bad-bg); text-align: left; cursor: pointer;
    }
    .scenario-grid button.restore { border-color: #286849; background: var(--ok-bg); }
    .scenario-grid button:hover:not(:disabled) { filter: brightness(1.22); }
    .scenario-grid button:disabled { cursor: not-allowed; opacity: 0.45; }
    .scenario-grid strong, .scenario-grid span { display: block; }
    .scenario-grid strong { font-size: 0.8rem; }
    .scenario-grid span { margin-top: 0.25rem; color: var(--muted); font-size: 0.68rem; line-height: 1.35; }
    .control-error, .action-error { color: var(--bad); }
    .control-error code { color: var(--accent); font-family: var(--mono); }
    .last-action {
      display: grid; grid-template-columns: auto auto 1fr; gap: 0.55rem; align-items: center;
      margin-top: 0.7rem; padding: 0.45rem 0.55rem; border-radius: 5px; background: var(--panel-2);
      font-size: 0.72rem;
    }
    .last-action code { overflow: hidden; color: var(--muted); font-family: var(--mono);
      text-overflow: ellipsis; white-space: nowrap; }
    .action-status { color: var(--accent); text-transform: uppercase; font: 0.64rem var(--mono); }
    .last-action.failed .action-status { color: var(--bad); }
    .timeline-head { margin-top: 1rem; }
    .filters { display: flex; gap: 0.3rem; }
    .filters button {
      padding: 0.2rem 0.5rem; border: 1px solid var(--line); border-radius: 999px;
      background: transparent; color: var(--muted); font-size: 0.66rem; cursor: pointer;
    }
    .filters button.active { border-color: var(--accent); color: var(--accent); background: #12283a; }
    .timeline { list-style: none; margin: 0.65rem 0 0; padding: 0; max-height: 32rem; overflow-y: auto; }
    .timeline li {
      display: grid; grid-template-columns: 4.8rem 5.8rem 1fr; gap: 0.55rem;
      padding: 0.32rem 0.4rem; border-left: 2px solid var(--line);
      border-bottom: 1px solid var(--line); font: 0.73rem var(--mono);
    }
    .timeline time { color: var(--muted); }
    .timeline .source { color: var(--accent); text-transform: uppercase; font-size: 0.63rem; }
    .timeline strong { font-weight: 600; }
    .timeline strong + span { margin-left: 0.45rem; color: var(--muted); }
    .timeline li.good { border-left-color: var(--ok); }
    .timeline li.warn { border-left-color: var(--warn); }
    .timeline li.bad { border-left-color: var(--bad); background: #21151a; }
    .timeline li.ai { border-left-color: #b884f4; background: #1d1726; }
    .empty { color: var(--muted); }
    @media (max-width: 760px) {
      .scenario-grid { grid-template-columns: 1fr; }
      .timeline li { grid-template-columns: 4.5rem 5.2rem 1fr; }
      .last-action { grid-template-columns: auto 1fr; }
      .last-action code { grid-column: 1 / -1; }
    }
  `],
})
export class OperationsConsoleComponent implements OnInit {
  readonly healthChecks = input.required<HealthCheck[]>();
  readonly events = input.required<NetworkEvent[]>();
  readonly logs = input.required<NetworkLog[]>();
  readonly incidents = input.required<Incident[]>();
  readonly agentRuns = input.required<AgentRun[]>();
  readonly actions = input.required<LabAction[]>();
  readonly control = inject(LabControlService);
  readonly filter = signal<Filter>('all');
  readonly filterOptions: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'problems', label: 'Problems' },
    { id: 'ai', label: 'AI' },
    { id: 'raw', label: 'Raw logs' },
  ];

  private readonly entries = computed(() => buildEntries(
    this.healthChecks(), this.events(), this.logs(), this.incidents(), this.agentRuns(), this.actions(),
  ));
  readonly visibleEntries = computed(() => {
    const filter = this.filter();
    return this.entries().filter((entry) =>
      filter === 'all' ||
      (filter === 'problems' && entry.problem) ||
      (filter === 'ai' && entry.source === 'luna') ||
      (filter === 'raw' && entry.source === 'frr'),
    ).slice(0, 250);
  });

  ngOnInit(): void { this.control.start(); }

  trigger(id: ScenarioId, label: string): void {
    if (id !== 'restore' && !window.confirm(`Trigger “${label}” in the local lab?`)) return;
    void this.control.trigger(id);
  }

  time(value: Date | null): string {
    return value === null ? '--:--:--' : value.toTimeString().slice(0, 8);
  }
}

function buildEntries(
  checks: HealthCheck[], events: NetworkEvent[], logs: NetworkLog[], incidents: Incident[],
  runs: AgentRun[], actions: LabAction[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const check of checks) entries.push({
    id: `health-${check.id}`, at: check.checkedAt, source: 'health',
    title: check.status === 'down' ? `${check.deviceId} unreachable` : `${check.deviceId} healthy`,
    detail: check.status === 'down' ? (check.error ?? 'ICMP probe received no reply') : latency(check.latencyMs),
    tone: check.status === 'down' ? 'bad' : 'good', problem: check.status === 'down',
  });
  for (const event of events) entries.push({
    id: `event-${event.id}`, at: event.occurredAt, source: 'event',
    title: `${event.deviceId} · ${event.eventType.replaceAll('_', ' ')}`,
    detail: event.source === 'health-service' ? 'emitted by health checker' : eventDetail(event),
    tone: event.severity === 'critical' ? 'bad' : event.severity === 'warning' ? 'warn' : 'good',
    problem: event.severity !== 'info',
  });
  for (const log of logs) entries.push({
    id: `log-${log.id}`, at: log.receivedAt, source: 'frr',
    title: `${log.deviceId} · ${log.daemon ?? 'device'}`, detail: log.raw,
    tone: log.normalized ? 'warn' : 'normal', problem: log.normalized,
  });
  for (const incident of incidents) entries.push({
    id: `incident-${incident.id}-${incident.status}`, at: incident.resolvedAt ?? incident.startedAt,
    source: 'incident', title: `${incident.incidentId} ${incident.status}`,
    detail: incident.probableRootCause || `correlating ${incident.eventCount} events`,
    tone: incident.status === 'open' ? 'bad' : 'good', problem: incident.status === 'open',
  });
  for (const run of runs) entries.push({
    id: `agent-${run.id}-${run.stage}`, at: run.completedAt ?? run.startedAt, source: 'luna',
    title: run.status === 'completed' ? `AI: ${run.conclusion?.summary ?? 'investigation complete'}`
      : run.status === 'failed' ? 'AI investigation failed' : `AI ${run.stage.replace('_', ' ')}`,
    detail: run.status === 'completed' ? `${run.agreement ?? 'uncompared'} · ${run.totalTokens} tokens · ${run.latencyMs ?? 0} ms`
      : run.error ?? `${run.evidenceEventIds.length} events, ${run.evidenceLogIds.length} logs`,
    tone: run.status === 'failed' ? 'bad' : 'ai', problem: run.status === 'failed',
  });
  for (const action of actions) entries.push({
    id: `action-${action.id}-${action.status}`, at: action.completedAt ?? action.requestedAt,
    source: 'control', title: `${action.label} · ${action.status}`,
    detail: action.error ?? action.output[action.output.length - 1] ?? '',
    tone: action.status === 'failed' ? 'bad' : action.status === 'completed' ? 'good' : 'warn',
    problem: action.status === 'failed' || action.scenario !== 'restore',
  });
  return entries.sort((left, right) => (right.at?.getTime() ?? 0) - (left.at?.getTime() ?? 0));
}

function latency(value: number | null): string {
  return value === null ? 'probe completed' : `${value.toFixed(3)} ms`;
}

function eventDetail(event: NetworkEvent): string {
  const iface = event.attributes['interface'];
  const neighbor = event.attributes['neighborId'];
  return [typeof iface === 'string' ? iface : '', typeof neighbor === 'string' ? `neighbor ${neighbor}` : '']
    .filter(Boolean).join(' · ');
}
