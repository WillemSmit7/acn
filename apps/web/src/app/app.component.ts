import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DataService } from './data.service';
import { emulatorLabel } from './firebase';
import { TopologyStripComponent } from './components/topology-strip.component';
import { IncidentDetailComponent } from './components/incident-detail.component';
import { EventFeedComponent } from './components/event-feed.component';
import { AgentRunsComponent } from './components/agent-runs.component';
import { OperationsConsoleComponent } from './components/operations-console.component';
import type { Incident } from './models';

/**
 * ACN NOC dashboard - live view of the telemetry and AI investigation pipeline.
 *
 * Top to bottom it follows the same path the data takes: the network, the
 * events normalized out of it, and the incidents correlated from those. Nothing
 * Manual demo controls call a separate localhost-only controller with three
 * whitelisted lab scenarios; the browser still has no Firestore write access.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    TopologyStripComponent,
    IncidentDetailComponent,
    AgentRunsComponent,
    OperationsConsoleComponent,
    EventFeedComponent,
  ],
  template: `
    <header>
      <div class="brand">
        <h1>ACN</h1>
        <span class="sub">AI-Centered Network &mdash; NOC</span>
      </div>
      <div class="conn" [class.up]="data.connected()">
        <span class="dot"></span>
        {{ data.connected() ? 'live' : 'connecting' }}
        <span class="host">{{ emulator }}</span>
      </div>
    </header>

    @if (data.error(); as message) {
      <!-- An empty dashboard and a broken one look identical, so say which. -->
      <div class="error">
        <strong>Not reading Firestore.</strong> {{ message }}
        <div>Is the emulator running? <code>npm run emulators</code></div>
      </div>
    }

    <main>
      <section class="card">
        <h2>Network</h2>
        <acn-topology-strip [states]="data.deviceStates()" />
        @if (data.deviceStates().length === 0) {
          <p class="empty">
            No devices yet. Start the Health Service:
            <code>npm run health-service</code>
          </p>
        }
      </section>

      <section class="card operations">
        <acn-operations-console
          [healthChecks]="data.healthChecks()"
          [events]="data.events()"
          [logs]="data.logs()"
          [incidents]="data.incidents()"
          [agentRuns]="data.agentRuns()"
          [actions]="data.labActions()" />
      </section>

      <section class="card">
        <div class="card-head">
          <h2>GPT investigator</h2>
          <span class="count">{{ data.agentRuns().length }} recent run(s)</span>
        </div>
        <acn-agent-runs [runs]="data.agentRuns()" />
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Incidents</h2>
          <span class="count">
            {{ data.openIncidents().length }} open / {{ data.incidents().length }} total
          </span>
        </div>

        @if (data.incidents().length === 0) {
          <p class="empty">
            Nothing correlated yet. Start the Incident Service and break a link:
            <code>npm run incident-service</code>
          </p>
        } @else {
          <ul class="incidents">
            @for (incident of data.incidents(); track incident.id) {
              <li [class.open]="incident.status === 'open'">
                <button class="row" (click)="toggle(incident)"
                        [attr.aria-expanded]="isExpanded(incident)">
                  <span class="chev">{{ isExpanded(incident) ? '&#9662;' : '&#9656;' }}</span>
                  <span class="id">{{ incident.incidentId }}</span>
                  <span class="status" [class.resolved]="incident.status === 'resolved'">
                    {{ incident.status }}
                  </span>
                  <span class="cause">{{ incident.probableRootCause }}</span>
                  <span class="devices">{{ incident.affectedDevices.join(', ') }}</span>
                  <span class="when">{{ started(incident) }}</span>
                </button>
                @if (isExpanded(incident)) {
                  <acn-incident-detail [incident]="incident" />
                }
              </li>
            }
          </ul>
        }
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Normalized events</h2>
          <span class="count">{{ data.events().length }} most recent</span>
        </div>
        <acn-event-feed [events]="data.events()" />
      </section>
    </main>
  `,
  styles: [`
    :host {
      --bg: #0f1115; --panel: #171a21; --panel-2: #1d2029; --chip: #272b36;
      --line: #2a2e3a; --text: #e6e8ee; --muted: #8b93a7;
      --ok: #48c78e; --ok-bg: #10281f; --bad: #f14668; --bad-bg: #2a141a;
      --warn: #ffbf5f; --accent: #5aa9e6;
      --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
      display: block; min-height: 100vh; background: var(--bg); color: var(--text);
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    header {
      display: flex; justify-content: space-between; align-items: center;
      gap: 1rem; flex-wrap: wrap;
      padding: 0.9rem 1.2rem; border-bottom: 1px solid var(--line);
    }
    .brand { display: flex; align-items: baseline; gap: 0.6rem; }
    h1 { margin: 0; font-size: 1.15rem; letter-spacing: 0.12em; }
    .sub { color: var(--muted); font-size: 0.8rem; }
    .conn {
      display: flex; align-items: center; gap: 0.4rem;
      font-size: 0.75rem; color: var(--muted); font-family: var(--mono);
    }
    .dot {
      width: 0.5rem; height: 0.5rem; border-radius: 50%;
      background: var(--warn);
    }
    .conn.up .dot { background: var(--ok); }
    .host { opacity: 0.7; }
    .error {
      margin: 1rem 1.2rem; padding: 0.7rem 0.9rem; border-radius: 6px;
      background: var(--bad-bg); border: 1px solid var(--bad); font-size: 0.85rem;
    }
    .error code { font-family: var(--mono); }
    main {
      display: flex; flex-direction: column; gap: 1rem;
      padding: 1.2rem; max-width: 78rem; margin: 0 auto;
    }
    .card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 10px; padding: 0.9rem 1rem;
    }
    .card-head { display: flex; justify-content: space-between; align-items: baseline; }
    h2 {
      margin: 0 0 0.7rem; font-size: 0.75rem; text-transform: uppercase;
      letter-spacing: 0.1em; color: var(--muted);
    }
    .count { font-size: 0.72rem; color: var(--muted); font-family: var(--mono); }
    .empty { color: var(--muted); font-size: 0.85rem; margin: 0.6rem 0 0; }
    .empty code { font-family: var(--mono); font-size: 0.78rem; color: var(--accent); }
    ul.incidents { list-style: none; margin: 0; padding: 0; }
    ul.incidents > li {
      border: 1px solid var(--line); border-radius: 8px;
      margin-bottom: 0.5rem; overflow: hidden; background: var(--panel-2);
    }
    ul.incidents > li.open { border-left: 3px solid var(--bad); }
    button.row {
      display: grid; width: 100%;
      grid-template-columns: 1.2rem 4.5rem 5rem 1fr auto auto;
      gap: 0.6rem; align-items: center; text-align: left;
      padding: 0.55rem 0.7rem; background: none; border: 0;
      color: inherit; font: inherit; cursor: pointer;
    }
    button.row:hover { background: var(--chip); }
    .chev { color: var(--muted); }
    .id { font-family: var(--mono); font-weight: 600; }
    .status {
      font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 0.12rem 0.4rem; border-radius: 999px;
      background: var(--bad-bg); color: var(--bad); text-align: center;
    }
    .status.resolved { background: var(--ok-bg); color: var(--ok); }
    .cause { font-size: 0.88rem; }
    .devices, .when { font-size: 0.72rem; color: var(--muted); font-family: var(--mono); }
    @media (max-width: 760px) {
      button.row { grid-template-columns: 1.2rem 4.5rem 1fr; }
      .status, .devices, .when { display: none; }
    }
  `],
})
export class AppComponent implements OnInit {
  readonly data = inject(DataService);
  readonly emulator = emulatorLabel;

  private readonly expanded = signal<string | null>(null);

  /**
   * What to show expanded before anyone clicks. An open incident is the thing
   * that needs attention; failing that the most recent one, so the page always
   * lands on something worth reading rather than a list of collapsed rows.
   */
  private readonly autoExpand = computed(
    () => this.data.openIncidents()[0]?.id ?? this.data.incidents()[0]?.id ?? null,
  );

  ngOnInit(): void {
    this.data.start();
  }

  isExpanded(incident: Incident): boolean {
    const chosen = this.expanded();
    return chosen === null ? this.autoExpand() === incident.id : chosen === incident.id;
  }

  toggle(incident: Incident): void {
    this.expanded.set(this.isExpanded(incident) ? '' : incident.id);
  }

  started(incident: Incident): string {
    return incident.startedAt === null
      ? ''
      : incident.startedAt.toTimeString().slice(0, 8);
  }
}
