import { Injectable, signal } from '@angular/core';

export type ScenarioId =
  | 'configuration-drift'
  | 'routing-session-failure'
  | 'interface-disabled'
  | 'routing-service-crash'
  | 'resource-exhaustion'
  | 'restore';

export interface ScenarioOption {
  id: ScenarioId;
  label: string;
  description: string;
  tone: 'danger' | 'restore';
}

export interface TriggerResult {
  ok: boolean;
  error: string | null;
}

interface ControllerStatus {
  busy: boolean;
  scenarios: ScenarioOption[];
}

const ENDPOINT = 'http://127.0.0.1:8787';
const FALLBACK_SCENARIOS: ScenarioOption[] = [
  {
    id: 'configuration-drift',
    label: 'Introduce config drift',
    description: 'Change the intended OSPF cost on R2 eth2.',
    tone: 'danger',
  },
  {
    id: 'routing-session-failure',
    label: 'Break OSPF session',
    description: 'Make R2 eth2 passive while its link stays up.',
    tone: 'danger',
  },
  {
    id: 'interface-disabled',
    label: 'Disable R2 eth2',
    description: 'Administratively disable the logical port toward R3.',
    tone: 'danger',
  },
  {
    id: 'routing-service-crash',
    label: 'Stop R3 ospfd',
    description: 'Stop the routing daemon without stopping the router.',
    tone: 'danger',
  },
  {
    id: 'resource-exhaustion',
    label: 'Exhaust R3 CPU',
    description: 'Apply bounded control-plane pressure that starves OSPF.',
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

  async trigger(id: ScenarioId): Promise<TriggerResult> {
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
      return { ok: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.connected.set(false);
      this.error.set(message);
      return { ok: false, error: message };
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
