import { Injectable } from '@angular/core';
import { collection, doc, getDocFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { buildIncidentReport, investigationReportReady, reportIds, reportObject, type IncidentReport, type ReportRecord } from './incident-report';

/** Read-only server snapshot, independent of the live dashboard's recent windows. */
@Injectable({ providedIn: 'root' })
export class IncidentReportService {
  watchReady(incidentId: string, ready: (value: boolean) => void, failed: () => void): () => void {
    return onSnapshot(query(collection(db(), 'agentRuns'), where('incidentId', '==', incidentId), orderBy('startedAt', 'desc'), limit(1)), snapshot => {
      ready(investigationReportReady(snapshot.docs.map(record => {
        const data = record.data();
        return { status: String(data['status'] ?? ''), startedAt: data['startedAt'], conclusion: data['conclusion'] };
      })));
    }, () => { ready(false); failed(); });
  }

  async load(documentId: string): Promise<IncidentReport> {
    const warnings: string[] = [];
    const read = async (name: string, id: string): Promise<ReportRecord | null> => {
      if (!id || id.includes('/')) { warnings.push(`Invalid ${name} reference: ${id}.`); return null; }
      const snapshot = await getDocFromServer(doc(db(), name, id));
      if (!snapshot.exists()) { warnings.push(`Missing record: ${name}/${id}.`); return null; }
      return { id: snapshot.id, data: snapshot.data() };
    };
    const related = async (name: string, field: string, value: string): Promise<ReportRecord[]> => {
      const filters = name === 'agentRuns' ? [where(field, '==', value), orderBy('startedAt', 'desc'), limit(501)] : [where(field, '==', value), limit(501)];
      const snapshot = await getDocsFromServer(query(collection(db(), name), ...filters));
      if (snapshot.size === 501) warnings.push(`${name}: report limited to 500 records; history may be incomplete.`);
      return snapshot.docs.slice(0, 500).map(record => ({ id: record.id, data: record.data() }));
    };
    const incident = await read('incidents', documentId);
    if (!incident) throw new Error('The incident is unavailable. No report was generated.');
    const incidentId = typeof incident.data['incidentId'] === 'string' ? incident.data['incidentId'] : documentId;
    const [runs, actions, audits] = await Promise.all([
      related('agentRuns', 'incidentId', incidentId), related('agentActions', 'incidentId', incidentId),
      related('actionAuditEvents', 'incidentId', incidentId),
    ]);
    if (!investigationReportReady(runs.map(run => ({
      status: String(run.data['status'] ?? ''), startedAt: run.data['startedAt'], conclusion: run.data['conclusion'],
    })))) throw new Error('The latest investigation must finish successfully before its PDF can be downloaded.');
    const eventIds = new Set(reportIds(incident.data['eventIds']));
    const logIds = new Set<string>();
    for (const run of runs) {
      const refs = reportObject(run.data['citedEvidence']);
      const conclusion = reportObject(run.data['conclusion']);
      for (const id of reportIds(refs['eventIds'] ?? conclusion['citedEventIds'])) eventIds.add(id);
      for (const id of reportIds(refs['logIds'] ?? conclusion['citedLogIds'])) logIds.add(id);
    }
    // Fixed-size batches avoid unbounded concurrent requests for long-running cases.
    const readMany = async (name: string, ids: Set<string>): Promise<ReportRecord[]> => {
      const result: ReportRecord[] = [];
      if (ids.size > 1000) warnings.push(`${name}: report limited to 1000 referenced records; evidence may be incomplete.`);
      const bounded = [...ids].slice(0, 1000);
      for (let i = 0; i < bounded.length; i += 20) {
        const batch = await Promise.all(bounded.slice(i, i + 20).map(id => read(name, id)));
        result.push(...batch.filter((record): record is ReportRecord => record !== null));
      }
      return result;
    };
    const events = await readMany('networkEvents', eventIds);
    for (const event of events) if (typeof event.data['sourceLogId'] === 'string') logIds.add(event.data['sourceLogId']);
    const logs = await readMany('networkLogs', logIds);
    return buildIncidentReport({ incident, runs, actions, events, logs, audits, warnings, generatedAt: new Date() });
  }

  async download(documentId: string): Promise<void> {
    const report = await this.load(documentId);
    const { downloadIncidentPdf } = await import('./incident-report-pdf');
    await downloadIncidentPdf(report);
  }
}
