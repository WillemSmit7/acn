import { Injectable, signal } from '@angular/core';

export type ScenarioId = 'link-failure' | 'router-failure' | 'restore';

export interface ScenarioOption {
  id: ScenarioId;
  label: string;
  description: string;
  tone: 'danger' | 'restore';
}

interface ControllerStatus {
  busy: boolean;
  scenarios: ScenarioOption[];
}

const ENDPOINT = 'http://127.0.0.1:8787';
const FALLBACK_SCENARIOS: ScenarioOption[] = [
  {
    id: 'link-failure',
    label: 'Break R2–R3 link',
    description: 'Shut R2 eth2 and watch r3 plus pc2 become unreachable.',
    tone: 'danger',
  },
  {
    id: 'router-failure',
    label: 'Stop R3 router',
    description: 'Create the same ICMP symptoms with a different root cause.',
    tone: 'danger',
  },
  {
    id: 'restore',
    label: 'Restore network',
    description: 'Restore nodes, links and OSPF convergence.',
    tone: 'restore',
  },
];

@Injectable({ providedIn: 'root' })
export class LabControlService {
  readonly connected = signal(false);
  readonly busy = signal(false);
  readonly sending = signal<ScenarioId | null>(null);
  readonly error = signal<string | null>(null);
  readonly scenarios = signal<ScenarioOption[]>(FALLBACK_SCENARIOS);
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer !== null) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2_000);
  }

  async trigger(id: ScenarioId): Promise<void> {
    this.sending.set(id);
    this.error.set(null);
    try {
      const response = await fetch(`${ENDPOINT}/api/actions/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Controller returned ${response.status}`);
      this.connected.set(true);
      this.busy.set(true);
    } catch (error) {
      this.connected.set(false);
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.sending.set(null);
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch(`${ENDPOINT}/api/status`);
      if (!response.ok) throw new Error(`Controller returned ${response.status}`);
      const status = await response.json() as ControllerStatus;
      this.connected.set(true);
      this.busy.set(status.busy);
      this.error.set(null);
      if (Array.isArray(status.scenarios) && status.scenarios.length > 0) {
        this.scenarios.set(status.scenarios);
      }
    } catch {
      this.connected.set(false);
      this.busy.set(false);
    }
  }
}
