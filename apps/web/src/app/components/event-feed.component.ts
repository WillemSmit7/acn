import { Component, input } from '@angular/core';
import type { NetworkEvent } from '../models';

/** The normalized event stream, newest first, from both producers. */
@Component({
  selector: 'acn-event-feed',
  standalone: true,
  template: `
    @if (events().length === 0) {
      <p class="empty">
        No events yet. Break something &mdash;
        <code>./lab/scenarios/03-interface-disabled.sh</code>
      </p>
    } @else {
      <ul class="feed acn-scroll">
        @for (event of events(); track event.id) {
          <li
            [class.critical]="event.severity === 'critical'"
            [class.warning]="event.severity === 'warning'"
          >
            <span class="time">{{ time(event.occurredAt) }}</span>
            <span class="dev">{{ event.deviceId }}</span>
            <span class="type">{{ event.eventType }}</span>
            <span class="detail">{{ detail(event) }}</span>
            <!-- Which independent watcher produced this observation. -->
            <span class="src" [class.log]="event.source === 'layer-zero'">
              {{ event.source === 'layer-zero' ? 'router watcher' : 'reachability watcher' }}
            </span>
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      .empty {
        color: var(--muted);
        font-size: 0.85rem;
      }
      .empty code {
        font-family: var(--mono);
        font-size: 0.78rem;
      }
      .feed {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 22rem;
        overflow-y: auto;
      }
      .feed li {
        display: grid;
        grid-template-columns: 5rem 3rem 11rem 1fr 9rem;
        gap: 0.5rem;
        align-items: baseline;
        padding: 0.25rem 0.3rem;
        border-bottom: 1px solid var(--line);
        font-size: 0.78rem;
        font-family: var(--mono);
      }
      .feed li.critical .type {
        color: var(--bad);
        font-weight: 600;
      }
      .feed li.warning .type {
        color: var(--warn);
      }
      .time,
      .src {
        color: var(--muted);
      }
      .dev {
        font-weight: 600;
      }
      .detail {
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .src {
        text-align: right;
        font-size: 0.65rem;
        text-transform: uppercase;
      }
      .src.log {
        color: var(--accent);
      }
      @media (max-width: 700px) {
        .feed li {
          grid-template-columns: 4.5rem 3rem 1fr;
        }
        .detail,
        .src {
          display: none;
        }
      }
    `,
  ],
})
export class EventFeedComponent {
  readonly events = input.required<NetworkEvent[]>();

  detail(event: NetworkEvent): string {
    return Object.entries(event.attributes)
      .filter((entry): entry is [string, string | number | boolean] =>
        ['string', 'number', 'boolean'].includes(typeof entry[1]))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' · ');
  }

  time(value: Date | null): string {
    return value === null ? '--:--:--' : value.toTimeString().slice(0, 8);
  }
}
