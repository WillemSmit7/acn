import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class RemediationControlService {
  readonly busyActionId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  private readonly baseUrl = 'http://127.0.0.1:8788/api/actions';

  async approve(actionId: string, approver: string): Promise<void> {
    await this.post(actionId, 'approve', { approver });
  }

  async reject(actionId: string, approver: string, reason: string): Promise<void> {
    await this.post(actionId, 'reject', { approver, reason });
  }

  private async post(actionId: string, operation: 'approve' | 'reject', body: unknown): Promise<void> {
    this.busyActionId.set(actionId);
    this.error.set(null);
    try {
      const response = await fetch(`${this.baseUrl}/${encodeURIComponent(actionId)}/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Network Controller rejected the request');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Network Controller is unavailable');
    } finally {
      this.busyActionId.set(null);
    }
  }
}
