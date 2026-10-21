import { Injectable, signal } from '@angular/core';
import { doc, getDoc, Timestamp, type DocumentData } from 'firebase/firestore';
import { db } from './firebase';

export type EvidenceCollection = 'networkEvents' | 'networkLogs';
export interface EvidenceRecord {
  status: 'loading' | 'ready' | 'missing' | 'error';
  data?: DocumentData;
  error?: string;
}

/** Resolve cited documents by ID; recent dashboard query limits must not hide evidence. */
@Injectable({ providedIn: 'root' })
export class CitedEvidenceService {
  private readonly records = signal<Record<string, EvidenceRecord>>({});

  state(collection: EvidenceCollection, id: string): EvidenceRecord | undefined {
    return this.records()[`${collection}/${id}`];
  }

  ensure(collection: EvidenceCollection, id: string): void {
    const key = `${collection}/${id}`;
    if (!id || this.records()[key]) return;
    this.set(key, { status: 'loading' });
    void this.fetch(collection, id, key);
  }

  retry(collection: EvidenceCollection, id: string): void {
    const key = `${collection}/${id}`;
    if (this.records()[key]?.status === 'loading') return;
    this.set(key, { status: 'loading' });
    void this.fetch(collection, id, key);
  }

  timestamp(value: unknown): string {
    const date = value instanceof Timestamp ? value.toDate() : value instanceof Date ? value : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : 'Timestamp unavailable';
  }

  format(value: unknown): string {
    return JSON.stringify(value ?? {}, (_key, item: unknown) => {
      if (item && typeof item === 'object' && 'seconds' in item && 'nanoseconds' in item) {
        const timestamp = item as { seconds: number; nanoseconds: number };
        if (typeof timestamp.seconds === 'number' && typeof timestamp.nanoseconds === 'number') {
          return new Date(timestamp.seconds * 1000 + timestamp.nanoseconds / 1e6).toISOString();
        }
      }
      return item;
    }, 2);
  }

  private async fetch(collection: EvidenceCollection, id: string, key: string): Promise<void> {
    try {
      const snapshot = await getDoc(doc(db(), collection, id));
      if (!snapshot.exists()) {
        this.set(key, { status: 'missing' });
        return;
      }
      const data = snapshot.data();
      this.set(key, { status: 'ready', data });
      if (collection === 'networkEvents' && typeof data['sourceLogId'] === 'string') {
        this.ensure('networkLogs', data['sourceLogId']);
      }
    } catch (error) {
      this.set(key, { status: 'error', error: error instanceof Error ? error.message : 'Evidence read failed' });
    }
  }

  private set(key: string, record: EvidenceRecord): void {
    this.records.update((records) => ({ ...records, [key]: record }));
  }
}
