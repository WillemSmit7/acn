import { Component, computed, input } from '@angular/core';
import type { DeviceState } from '../models';

/**
 * The lab topology, drawn in the order the devices are physically cabled:
 *
 *   PC1 --- R1 --- R2 --- R3 --- PC2
 *
 * Laying it out as the actual chain rather than an alphabetical list is what
 * makes a partial outage legible at a glance: when the R2-R3 link drops, the
 * right-hand half of the row goes red and the break is visible in place.
 */
@Component({
  selector: 'acn-topology-strip',
  standalone: true,
  template: `
    <section class="strip">
      @for (state of ordered(); track state.device.id; let last = $last) {
        <div class="node" [class.healthy]="state.status === 'healthy'"
             [class.down]="state.status === 'down'"
             [class.unknown]="state.status === 'unknown'">
          <div class="id">{{ state.device.id }}</div>
          <div class="addr">{{ state.device.checkAddress }}</div>
          <div class="latency">
            @if (state.status === 'healthy') {
              {{ formatLatency(state.latencyMs) }}
            } @else if (state.status === 'down') {
              unreachable
            } @else {
              no data
            }
          </div>
        </div>
        @if (!last) {
          <div class="link" [class.broken]="linkBroken($index)">
            <span>{{ linkBroken($index) ? '&#10007;' : '&mdash;' }}</span>
          </div>
        }
      }
    </section>
  `,
  styles: [`
    .strip { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; }
    .node {
      flex: 1 1 8rem; min-width: 8rem; padding: 0.75rem;
      border: 1px solid var(--line); border-radius: 8px;
      background: var(--panel); text-align: center;
    }
    .node.healthy { border-color: var(--ok); }
    .node.down { border-color: var(--bad); background: var(--bad-bg); }
    .node.unknown { opacity: 0.55; }
    .id { font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .addr { font-size: 0.75rem; color: var(--muted); font-family: var(--mono); }
    .latency { font-size: 0.75rem; margin-top: 0.25rem; font-family: var(--mono); }
    .node.healthy .latency { color: var(--ok); }
    .node.down .latency { color: var(--bad); font-weight: 600; }
    .link {
      display: flex; align-items: center; padding: 0 0.4rem;
      color: var(--muted); font-size: 1.1rem;
    }
    .link.broken { color: var(--bad); font-weight: 700; }
  `],
})
export class TopologyStripComponent {
  readonly states = input.required<DeviceState[]>();

  /** Physical cabling order, not alphabetical. */
  private static readonly ORDER = ['pc1', 'r1', 'r2', 'r3', 'pc2'];

  readonly ordered = computed(() => {
    const byId = new Map(this.states().map((state) => [state.device.id, state]));
    return TopologyStripComponent.ORDER.map((id) => byId.get(id)).filter(
      (state): state is DeviceState => state !== undefined,
    );
  });

  /** A link is shown broken when the device on its far side is unreachable. */
  linkBroken(index: number): boolean {
    const right = this.ordered()[index + 1];
    return right?.status === 'down';
  }

  formatLatency(latencyMs: number | null): string {
    if (latencyMs === null) return '-';
    return `${latencyMs.toFixed(latencyMs < 1 ? 3 : 1)}ms`;
  }
}
