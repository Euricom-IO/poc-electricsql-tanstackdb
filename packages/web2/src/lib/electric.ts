// web2 reads directly from the ElectricSQL sync layer (the shape HTTP API).
// The Electric service is exposed on host port 3010 by docker-compose.
export const ELECTRIC_URL = import.meta.env.VITE_ELECTRIC_URL ?? 'http://localhost:3010/v1/shape';

/**
 * Block until the browser reports connectivity, or the stream is torn down.
 *
 * `navigator.onLine === false` is a reliable "we are definitely offline" signal
 * (it is never a false negative), so gating on it can never wrongly stall a
 * request that could actually succeed. We also re-check on a short interval as a
 * safety net in case the `online` event is missed.
 */
function waitUntilOnline(signal?: AbortSignal | null): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearInterval(poll);
      window.removeEventListener('online', onOnline);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const poll = setInterval(() => {
      if (navigator.onLine) onOnline();
    }, 2000);
    window.addEventListener('online', onOnline);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Fetch client for the Electric ShapeStream.
 *
 * Electric's long-poll reconnects on an exponential backoff (up to 32s) and does
 * NOT listen for the browser's `online` event, so after a spell offline a client
 * can sit in a backoff sleep for tens of seconds before it resumes streaming —
 * during which rows created elsewhere while we were offline do not arrive, even
 * though the write queue (which does listen for `online`) has already drained.
 *
 * By holding the request while the browser is offline and releasing it the
 * instant `online` fires, the backoff never grows and the read stream resumes
 * immediately on reconnect. `backoffOptions.maxDelay` (below) still bounds the
 * "online but server unreachable" case.
 */
export const electricFetch: typeof fetch = async (input, init) => {
  await waitUntilOnline(init?.signal ?? null);
  return fetch(input, init);
};

/**
 * Cap the reconnect backoff so a genuinely unreachable server (network up, but
 * Electric/Postgres down) is retried at least every few seconds rather than
 * every 32s. Combined with `electricFetch`, true offline→online transitions
 * resume instantly and unreachable-server transitions resume within `maxDelay`.
 */
export const ELECTRIC_BACKOFF = {
  initialDelay: 1000,
  maxDelay: 5000,
  multiplier: 2,
};
