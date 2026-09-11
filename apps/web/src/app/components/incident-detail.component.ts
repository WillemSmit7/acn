import { Component, computed, inject, input } from '@angular/core';
import { DataService } from '../data.service';
import type { Incident, NetworkEvent } from '../models';

/** One grouped case: its scope, grouping rule, and exact watcher evidence. */
@Component({
  selector: 'acn-incident-detail',
  standalone: true,
  template: `
    @let inc = incident();
    <div class="detail">
      <p class="scope-note">
        <strong>Grouped case—not a diagnosis.</strong>
        This record keeps related watcher observations together, tracks their lifecycle,
        and supplies one evidence bundle to GPT. The root-cause answer appears separately.
      </p>

      <h4>Case scope</h4>
      <p class="case-scope">
        <strong>{{ inc.eventCount }}</strong> observations ·
        affected: <strong>{{ format(inc.affectedDevices) }}</strong> ·
        unreachable: <strong>{{ format(inc.unreachableDevices) }}</strong>
      </p>
      <p class="grouping-note">
        Grouped because these observations arrived within the correlation window
        and concern the same device, a directly connected device, or the named peer.
      </p>

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
    .case-scope { margin: 0.3rem 0; font-size: 0.85rem; color: var(--muted); }
    .case-scope strong { color: var(--text); }
    .grouping-note { margin: 0.35rem 0; color: var(--muted); font-size: 0.78rem; }
    ul { margin: 0; padding-left: 1.1rem; }
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
