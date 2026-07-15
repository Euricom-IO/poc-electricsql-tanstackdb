import { useEffect, useState, useSyncExternalStore } from 'react';
import { CloudOff, RefreshCw, Check } from 'lucide-react';
import { db } from '@/lib/powersync';
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
 * Header badge reflecting PowerSync state: the browser's online/offline status
 * and the number of local writes still queued for upload (PowerSync's CRUD
 * queue). The count drops to zero once the connector has flushed the queue to
 * the backend.
 */
export function SyncStatus() {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const stats = await db.getUploadQueueStats();
        if (active) setPending(stats.count);
      } catch {
        // Transient (e.g. DB busy) — the next poll will re-read.
      }
    };
    void refresh();
    // Poll the CRUD queue directly. This is the source of truth for "how many
    // local writes are still pending upload", and unlike event triggers it
    // always converges: a completed upload clears PowerSync's internal queue
    // (`ps_crud`, not a tracked table) without firing a todos/users onChange, so
    // an event-only approach could stay stuck on "Syncing". Polling settles it.
    const interval = setInterval(() => void refresh(), 500);
    // Also re-read the instant a tracked table changes so a new write flips the
    // badge to "Syncing" immediately rather than up to one poll interval later.
    const disposeChange = db.onChange(
      { onChange: () => void refresh() },
      { tables: ['todos', 'users'] },
    );
    return () => {
      active = false;
      clearInterval(interval);
      disposeChange();
    };
  }, []);

  return (
    <div className="flex items-center gap-2">
      {!online ? (
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
