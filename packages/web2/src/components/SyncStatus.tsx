import { useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudOff, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import { syncDb, type StoredEvent } from '@/lib/eventStore';
import { getStatus, subscribeStatus, retryEvent, discardEvent } from '@/lib/syncEngine';
import { cn } from '@/lib/utils';

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/**
 * Small header badge reflecting the offline sync engine: online/offline state,
 * the number of queued (pending) writes, and any dead-lettered (failed) events
 * with retry/dismiss controls.
 */
export function SyncStatus() {
  const status = useSyncExternalStore(subscribeStatus, getStatus);
  const navigatorOnline = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

  const pending =
    useLiveQuery(() => syncDb.events.where('status').anyOf(['pending', 'inflight']).count(), []) ?? 0;
  const failed =
    useLiveQuery(() => syncDb.events.where('status').equals('failed').toArray(), []) ?? [];

  const offline = !navigatorOnline || status === 'offline' || status === 'retrying';

  return (
    <div className="flex items-center gap-2">
      {offline ? (
        <Pill className="bg-amber-100 text-amber-800">
          <CloudOff className="size-3.5" />
          Offline{pending > 0 && ` · ${pending} pending`}
        </Pill>
      ) : pending > 0 ? (
        <Pill className="bg-muted text-muted-foreground">
          <RefreshCw className="size-3.5 animate-spin" />
          Syncing {pending}
        </Pill>
      ) : (
        <Pill className="bg-emerald-100 text-emerald-800">
          <Check className="size-3.5" />
          Synced
        </Pill>
      )}

      {failed.length > 0 && <FailedPill failed={failed} />}
    </div>
  );
}

function FailedPill({ failed }: { failed: StoredEvent[] }) {
  return (
    <div className="flex items-center gap-1.5">
      <Pill className="bg-red-100 text-red-800">
        <AlertTriangle className="size-3.5" />
        {failed.length} failed
      </Pill>
      <button
        type="button"
        className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => failed.forEach((e) => void retryEvent(e.eventId))}
      >
        Retry
      </button>
      <button
        type="button"
        className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => failed.forEach((e) => void discardEvent(e.eventId))}
      >
        Dismiss
      </button>
    </div>
  );
}

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        className,
      )}
    >
      {children}
    </span>
  );
}
