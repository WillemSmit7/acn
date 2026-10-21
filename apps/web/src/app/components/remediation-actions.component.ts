import { Component, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RemediationControlService } from '../remediation-control.service';
import type { ActionAuditEvent, AgentAction, NetworkChange } from '../models';

@Component({
  selector: 'acn-remediation-actions',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="operator">
      <label>Operator identity <input [(ngModel)]="approver" maxlength="80" /></label>
      <span>GPT proposes; this named human explicitly authorizes.</span>
    </div>
    @if (controls.error(); as message) { <p class="error">{{ message }}</p> }
    @if (actions().length === 0) {
      <p class="empty">No validated GPT repair proposals yet.</p>
    } @else {
      <ul>
        @for (action of actions(); track action.actionId) {
          <li [class.success]="action.status === 'succeeded'"
              [class.failure]="action.status === 'failed' || action.status === 'escalated'">
            <div class="head">
              <strong>GPT proposed · {{ label(action.tool) }}</strong>
              <span class="risk">{{ action.risk }} risk</span>
              <span class="status">{{ action.status }}</span>
            </div>
            <p>{{ action.rationale }}</p>
            <div class="meta">
              {{ action.incidentId }} · {{ action.agentRunId }} ·
              fixed target: {{ action.target?.deviceId ?? 'none' }} {{ action.target?.component ?? '' }}
            </div>
            <div class="citations">
              Evidence:
              @for (id of action.citedEvidenceIds; track id) { <code>{{ id }}</code> }
            </div>

            @if (action.status === 'proposed' && action.approvalRequired) {
              <div class="decision">
                <button class="approve" [disabled]="busy(action) || approver.trim().length < 2"
                        (click)="approve(action)">
                  {{ busy(action) ? 'Running guarded repair…' : 'Approve fixed repair' }}
                </button>
                <input [(ngModel)]="rejectionReason" maxlength="500" placeholder="Rejection reason" />
                <button [disabled]="busy(action) || rejectionReason.trim().length === 0"
                        (click)="reject(action)">Reject</button>
              </div>
            }
            @if (action.approvedBy) {
              <p class="approval">Authorized by {{ action.approvedBy }} at {{ time(action.approvedAt) }}</p>
            }
            @if (action.error) { <p class="error">{{ action.error }}</p> }
            @if (changeFor(action); as change) {
              <div class="outcome">
                Network change: {{ change.status }}
                @if (change.verification) { · {{ change.verification.reason }} }
              </div>
            }
            <details>
              <summary>Audit timeline</summary>
              @for (event of auditFor(action); track event.id) {
                <div class="audit">{{ time(event.occurredAt) }} · {{ event.actor }} · {{ event.transition }} — {{ event.reason }}</div>
              }
            </details>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    .operator, .head, .decision { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
    .operator { padding:.65rem; background:var(--panel-2); border-radius:7px; margin-bottom:.7rem; }
    .operator span, .meta, .approval, .audit, .citations, .pending { color:var(--muted); font-size:.72rem; }
    input { background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:5px; padding:.38rem .5rem; }
    ul { list-style:none; margin:0; padding:0; }
    li { padding:.8rem; margin-bottom:.6rem; border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:8px; background:var(--panel-2); }
    li.success { border-left-color:var(--ok); } li.failure { border-left-color:var(--bad); }
    .head strong { margin-right:auto; } .risk, .status { font-size:.65rem; text-transform:uppercase; }
    .risk, .status { padding:.15rem .42rem; border-radius:999px; background:var(--chip); }
    p { margin:.55rem 0; font-size:.83rem; } code { color:var(--accent); margin-left:.35rem; }
    .decision { margin-top:.7rem; } .decision input { flex:1; min-width:12rem; }
    button { border:1px solid var(--line); background:var(--chip); color:var(--text); padding:.4rem .65rem; border-radius:5px; cursor:pointer; }
    button.approve { border-color:var(--ok); color:var(--ok); } button:disabled { opacity:.45; cursor:not-allowed; }
    .error { color:var(--bad); } .outcome { margin-top:.6rem; padding:.45rem; background:var(--bg); font-size:.75rem; }
    details { margin-top:.6rem; } summary { cursor:pointer; font-size:.75rem; } .audit { margin:.3rem 0; }
  `],
})
export class RemediationActionsComponent {
  readonly actions = input.required<AgentAction[]>();
  readonly audits = input.required<ActionAuditEvent[]>();
  readonly changes = input.required<NetworkChange[]>();
  readonly controls = inject(RemediationControlService);
  approver = 'operator';
  rejectionReason = '';

  busy(action: AgentAction): boolean { return this.controls.busyActionId() === action.actionId; }
  approve(action: AgentAction): void { void this.controls.approve(action.actionId, this.approver.trim()); }
  reject(action: AgentAction): void {
    void this.controls.reject(action.actionId, this.approver.trim(), this.rejectionReason.trim());
  }
  auditFor(action: AgentAction): ActionAuditEvent[] {
    return this.audits().filter((event) => event.actionId === action.actionId).reverse();
  }
  changeFor(action: AgentAction): NetworkChange | undefined {
    return this.changes().find((change) => change.actionId === action.actionId);
  }
  label(value: string): string { return value.replaceAll('_', ' '); }
  time(value: Date | null): string { return value?.toLocaleTimeString() ?? 'pending'; }
}
