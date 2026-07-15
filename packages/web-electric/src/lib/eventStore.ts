import Dexie, { type Table } from 'dexie';
import type { SyncEntity, SyncOp } from '@app/db/types';

/**
 * Durable, offline-first event store for web2 writes.
 *
 * Every mutation is captured as one event and persisted to IndexedDB (via Dexie)
 * before it is sent to the backend, so nothing is lost across reloads or while
 * offline. The sync engine drains this queue FIFO. Each event carries an explicit
 * lifecycle so a terminal failure can be dead-lettered instead of retried forever.
 */

export type EventStatus = 'pending' | 'inflight' | 'failed';

export interface StoredEvent {
  /** Auto-increment key; also the FIFO ordering key. */
  localId?: number;
  /** Client-generated uuid — the idempotency key sent to the server. */
  eventId: string;
  entity: SyncEntity;
  op: SyncOp;
  payload: Record<string, unknown>;
  status: EventStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  lastAttemptAt?: string;
}

/** A new event as handed to the store — before it has a localId/status. */
export type NewEvent = Pick<StoredEvent, 'eventId' | 'entity' | 'op' | 'payload' | 'createdAt'>;

class SyncDB extends Dexie {
  events!: Table<StoredEvent, number>;

  constructor() {
    super('web2-sync');
    this.version(1).stores({
      // ++localId = auto-increment ordering key; eventId + status are indexed
      // for idempotency lookups and status filtering.
      events: '++localId, eventId, status, createdAt',
    });
  }
}

export const syncDb = new SyncDB();

export async function enqueue(event: NewEvent): Promise<number> {
  return syncDb.events.add({ ...event, status: 'pending', attempts: 0 });
}

/** The oldest still-sendable event (lowest localId, status 'pending'). */
export async function nextPending(): Promise<StoredEvent | undefined> {
  return syncDb.events.where('status').equals('pending').first();
}

export async function markInflight(localId: number): Promise<void> {
  await syncDb.events.update(localId, (e) => {
    e.status = 'inflight';
    e.attempts += 1;
    e.lastAttemptAt = new Date().toISOString();
  });
}

/** Return an event to the queue after a retryable (connectivity) failure. */
export async function markPending(localId: number, lastError?: string): Promise<void> {
  await syncDb.events.update(localId, (e) => {
    e.status = 'pending';
    if (lastError) e.lastError = lastError;
  });
}

/** Dead-letter an event after a terminal (non-retryable) failure. */
export async function markFailed(localId: number, lastError: string): Promise<void> {
  await syncDb.events.update(localId, (e) => {
    e.status = 'failed';
    e.lastError = lastError;
  });
}

export async function remove(localId: number): Promise<void> {
  await syncDb.events.delete(localId);
}

/**
 * On startup, any event left 'inflight' by a crash/reload mid-send is returned to
 * 'pending' so it is retried (the server is idempotent on the event id).
 */
export async function recoverInflight(): Promise<void> {
  await syncDb.events.where('status').equals('inflight').modify({ status: 'pending' });
}

export async function retryFailed(eventId: string): Promise<void> {
  await syncDb.events.where('eventId').equals(eventId).modify((e) => {
    e.status = 'pending';
    e.lastError = undefined;
  });
}

export async function discardFailed(eventId: string): Promise<void> {
  await syncDb.events.where('eventId').equals(eventId).delete();
}
