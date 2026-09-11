import { Component, computed, inject, input } from '@angular/core';
import { DataService } from '../data.service';
import type { Incident, NetworkEvent } from '../models';

/**
 * One incident, expanded: what the correlator concluded, why, and the evidence
 * chain underneath it.
 *
 * The chain is the point. Every log-derived event links back through
 * sourceLogId to the exact line a router emitted, so a claim like "R2 <-> R3
 * link failure" can be followed all the way down to the raw text without
 * leaving the page. An explanation you cannot check is not an explanation.
 */
@Component({
  selector: 'acn-incident-detail',
  standalone: true,
  template: `
    @let inc = incident();
    @let cause = inc.rootCause;

    <div class="detail">
      <p class="scope-note">
        <strong>Incident details only.</strong>
        This is the Incident Service's rule-based record of the observed lab fault.
        GPT's independent diagnosis appears in the GPT investigations card.
      </p>
      @if (cause) {
        <h4>Rule-based incident classification</h4>
        <div class="verdict" [class.confirmed]="cause.confidence === 'confirmed'">
          <div class="summary">{{ cause.summary }}</div>
          <div class="meta">
            <span class="tag">{{ cause.type.replace('_', ' ') }}</span>
            <span class="tag">{{ cause.confidence }}</span>
          </div>
        </div>

        <h4>Why the correlator grouped it this way</h4>
        <ul class="evidence">
          @for (line of cause.evidence; track line) {
            <li>{{ line }}</li>
          }
        </ul>

        <h4>Topology consistency check — not GPT analysis</h4>
        <p class="prediction" [class.match]="cause.predictionMatches">
          The stored incident classification predicts
          <strong>{{ format(cause.predictedUnreachable) }}</strong>
          should be unreachable; the network actually showed
          <strong>{{ format(cause.observedUnreachable) }}</strong>.
          <span class="badge">{{ cause.predictionMatches ? 'match' : 'mismatch' }}</span>
        </p>
      }

      @if (inc.symptoms.length) {
        <h4>Observed incident symptoms</h4>
        <ul class="symptoms">
          @for (symptom of inc.symptoms; track symptom) {
            <li>{{ symptom }}</li>
          }
        </ul>
      }

      <h4>Telemetry attached to this incident &mdash; {{ events().length }} of {{ inc.eventCount }} events</h4>
      @if (events().length < inc.eventCount) {
        <p class="note">
          Older events fall outside the window this page keeps in memory.
        </p>
      }
      <table class="events">
        <tbody>
          @for (event of events(); track event.id) {
            <tr [class.critical]="event.severity === 'critical'">
              <td class="time">{{ time(event.occurredAt) }}</td>
              <td class="dev">{{ event.deviceId }}</td>
              <td class="type">{{ event.eventType }}</td>
              <td class="src">{{ event.source }}</td>
              <td class="raw">
                @let log = logFor(event);
                @if (log) {
                  <code>{{ log.raw }}</code>
                } @else if (event.source === 'health-service') {
                  <span class="none">ICMP probe &mdash; no originating log line</span>
                } @else {
                  <span class="none">raw line no longer in view</span>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    .detail { padding: 0.75rem 1rem 1rem; border-top: 1px solid var(--line); }
    .scope-note {
      margin: 0 0 0.8rem; padding: 0.55rem 0.7rem; border: 1px solid var(--line);
      border-radius: 6px; color: var(--muted); background: var(--panel-2);
      font-size: 0.78rem; line-height: 1.45;
    }
    .scope-note strong { color: var(--text); }
    h4 {
      margin: 1rem 0 0.4rem; font-size: 0.72rem; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--muted);
    }
    .verdict {
      display: flex; justify-content: space-between; align-items: center;
      gap: 1rem; flex-wrap: wrap;
      padding: 0.6rem 0.8rem; border-radius: 6px;
      background: var(--panel-2); border-left: 3px solid var(--warn);
    }
    .verdict.confirmed { border-left-color: var(--bad); }
    .summary { font-weight: 600; font-size: 1rem; }
    .meta { display: flex; gap: 0.4rem; }
    .tag {
      font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 0.15rem 0.45rem; border-radius: 999px;
      background: var(--chip); color: var(--muted);
    }
    ul { margin: 0; padding-left: 1.1rem; }
    .evidence li, .symptoms li { margin: 0.15rem 0; font-size: 0.85rem; }
    .prediction { font-size: 0.85rem; margin: 0.3rem 0; }
    .badge {
      margin-left: 0.4rem; padding: 0.1rem 0.4rem; border-radius: 4px;
      font-size: 0.7rem; text-transform: uppercase; background: var(--bad-bg); color: var(--bad);
    }
    .prediction.match .badge { background: var(--ok-bg); color: var(--ok); }
    .note { font-size: 0.75rem; color: var(--muted); margin: 0.2rem 0; }
    table.events { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    table.events td { padding: 0.25rem 0.4rem; border-top: 1px solid var(--line); vertical-align: top; }
    .time, .dev, .type, .src { white-space: nowrap; font-family: var(--mono); }
    .dev { font-weight: 600; }
    .src { color: var(--muted); }
    tr.critical .type { color: var(--bad); font-weight: 600; }
    .raw code {
      font-family: var(--mono); font-size: 0.72rem; color: var(--muted);
      word-break: break-all;
    }
    .none { color: var(--muted); font-style: italic; font-size: 0.72rem; }
  `],
})
export class IncidentDetailComponent {
  readonly incident = input.required<Incident>();
  private readonly data = inject(DataService);

  readonly events = computed(() => this.data.eventsFor(this.incident()));

  logFor(event: NetworkEvent) {
    return this.data.logFor(event.sourceLogId);
  }

  format(devices: string[]): string {
    return devices.length === 0 ? 'nothing' : devices.join(', ');
  }

  time(value: Date | null): string {
    return value === null ? '--:--:--' : value.toTimeString().slice(0, 8);
  }
}
