import type { SyncCommand, SyncEntity, SyncOp } from '@app/db/types';
import { api, ApiError } from '@/lib/api';
import {
  enqueue,
  nextPending,
  markInflight,
  markPending,
  markFailed,
  remove,
  recoverInflight,
  retryFailed as storeRetryFailed,
  discardFailed as storeDiscardFailed,
  type StoredEvent,
} from '@/lib/eventStore';

/**
 * Offline sync engine. Drains the durable event store FIFO to POST /api/events,
 * one command at a time. On a connectivity failure it retries with a fixed
 * backoff (1s, 2s, 5s, 10s) and then postpones until connectivity returns — a
 * browser `online` event or a `/health` heartbeat. Terminal (4xx) failures are
 * dead-lettered so they are not retried forever.
 */

const BACKOFF_MS = [1000, 2000, 5000, 10000];
const HEARTBEAT_MS = 5000;

export type SyncStatus = 'idle' | 'syncing' | 'retrying' | 'offline';

let status: SyncStatus = 'idle';
const statusListeners = new Set<(s: SyncStatus) => void>();

function setStatus(next: SyncStatus): void {
  if (next === status) return;
  status = next;
  for (const l of statusListeners) l(status);
}

export function getStatus(): SyncStatus {
  return status;
}

export function subscribeStatus(listener: (s: SyncStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

// --- pending optimistic-write promises (in-memory; empty after a reload) ------

type Resolver = { resolve: (r: { txid: number }) => void; reject: (e: unknown) => void };
const pending = new Map<string, Resolver>();

function settleResolved(eventId: string, txid: number): void {
  pending.get(eventId)?.resolve({ txid });
  pending.delete(eventId);
}

function settleRejected(eventId: string, error: unknown): void {
  pending.get(eventId)?.reject(error);
  pending.delete(eventId);
}

// --- backoff wake + heartbeat -------------------------------------------------

let wake: (() => void) | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/** A backoff sleep that can be cut short when connectivity returns. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(async () => {
    try {
      await api('/api/health');
      stopHeartbeat();
      void pump();
    } catch {
      // still offline — keep polling
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

// --- classification -----------------------------------------------------------

/** A terminal error means the command will never apply — dead-letter it. */
function isTerminal(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.status === 408 || err.status === 429) return false; // transient
    return err.status >= 400 && err.status < 500; // other client errors are terminal
  }
  return false; // network/other -> connectivity, retry
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toCommand(ev: StoredEvent): SyncCommand {
  return { id: ev.eventId, entity: ev.entity, op: ev.op, payload: ev.payload, createdAt: ev.createdAt };
}

// --- the pump -----------------------------------------------------------------

let pumping = false;
let backoffIndex = 0;

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const ev = await nextPending();
      if (!ev || ev.localId === undefined) {
        setStatus('idle');
        break;
      }

      setStatus('syncing');
      await markInflight(ev.localId);
      try {
        const { txid } = await api<{ txid: number }>('/api/events', {
          method: 'POST',
          body: JSON.stringify(toCommand(ev)),
        });
        await remove(ev.localId);
        settleResolved(ev.eventId, txid);
        backoffIndex = 0;
        stopHeartbeat();
      } catch (err) {
        if (isTerminal(err)) {
          await markFailed(ev.localId, errorMessage(err));
          settleRejected(ev.eventId, err);
          backoffIndex = 0;
          continue;
        }
        // Connectivity failure: keep the event, back off, then postpone.
        await markPending(ev.localId, errorMessage(err));
        if (backoffIndex < BACKOFF_MS.length) {
          setStatus('retrying');
          await sleep(BACKOFF_MS[backoffIndex]!);
          backoffIndex += 1;
          continue;
        }
        backoffIndex = 0;
        setStatus('offline');
        startHeartbeat();
        break;
      }
    }
  } finally {
    pumping = false;
  }
}

// --- public API ---------------------------------------------------------------

export interface CommandInput {
  entity: SyncEntity;
  op: SyncOp;
  payload: Record<string, unknown>;
}

/**
 * Capture a mutation as a durable command and return a promise that resolves
 * with its `{ txid }` once the server applies it (so the Electric collection can
 * reconcile the optimistic row), or rejects if it is terminally rejected.
 */
export async function submitCommand(input: CommandInput): Promise<{ txid: number }> {
  const eventId = crypto.randomUUID();
  const result = new Promise<{ txid: number }>((resolve, reject) => {
    pending.set(eventId, { resolve, reject });
  });
  await enqueue({
    eventId,
    entity: input.entity,
    op: input.op,
    payload: input.payload,
    createdAt: new Date().toISOString(),
  });
  void pump();
  return result;
}

/** Re-queue a dead-lettered event for another attempt. */
export async function retryEvent(eventId: string): Promise<void> {
  await storeRetryFailed(eventId);
  void pump();
}

/** Permanently drop a dead-lettered event. */
export async function discardEvent(eventId: string): Promise<void> {
  await storeDiscardFailed(eventId);
}

function onOnline(): void {
  wake?.();
  void pump();
}

let started = false;

/** Wire up connectivity listeners and drain anything left from a prior session. */
export function initSyncEngine(): void {
  if (started) return;
  started = true;
  window.addEventListener('online', onOnline);
  void recoverInflight().then(() => pump());
}
