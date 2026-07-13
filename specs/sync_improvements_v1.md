# Sync Layer Robustness Review

A critical review of the web2 offline-sync layer: the durable client queue
(`packages/web2/src/lib/eventStore.ts`), the pump
(`packages/web2/src/lib/syncEngine.ts`), the TanStack DB + Electric collections
(`packages/web2/src/collections/*.ts`), the read stream
(`packages/web2/src/lib/electric.ts`), and the server write path
(`packages/api/src/routes/events.ts` + services).

The design is sound on the happy path and handles crash/reload/replay well
(durable IndexedDB queue, idempotency ledger, txid reconciliation,
connectivity-aware backoff). The fragility is concentrated in **error
classification and liveness**, plus two gaps that undercut the otherwise-careful
security model.

Issues are ordered worst-first. Each has a concrete failure scenario and one or
more proposed solutions.

---

## 1. A poison message stalls the entire queue forever (no attempt cap)

**Severity: Critical**

`isTerminal()` (`syncEngine.ts:105`) classifies **only** 4xx (minus 408/429) as
terminal. Every **5xx is treated as "connectivity"** → infinite retry with
backoff, then the `/health` heartbeat loop forever. The queue is strict FIFO
(`nextPending` returns the oldest `pending`), so a command that *deterministically*
returns 500 head-of-line-blocks **every** subsequent write permanently. The UI
just shows "Offline" even though the network is fine.

`attempts` is incremented on every `markInflight` (`eventStore.ts:57`) but is
**never read** — there is no max-attempts dead-letter and no circuit breaker.

**How a deterministic 500 happens**
- An empty todo/user update patch → Drizzle `update … set {}` throws → 500 (see issue #6).
- The concurrent-duplicate ledger race (see issue #8).
- Any future bug in `dispatch`.

**Failure scenario**
1. Client enqueues an update whose patch resolves to `{}`.
2. Server throws → 500 → `isTerminal` returns `false` → event stays `pending`.
3. Pump backs off (1s/2s/5s/10s), then heartbeats every 5s, forever.
4. Every write queued after it never sends. UI is stuck "Offline" indefinitely.

**Solution A — Attempt cap + dead-letter (recommended)**

Consult the already-tracked `attempts` field and dead-letter after N tries,
regardless of error class:

```ts
const MAX_ATTEMPTS = 8;

// in pump(), inside the catch for a non-terminal error:
if (ev.attempts >= MAX_ATTEMPTS) {
  await markFailed(ev.localId, `giving up after ${ev.attempts} attempts: ${errorMessage(err)}`);
  settleRejected(ev.eventId, err);
  backoffIndex = 0;
  continue; // unblock the rest of the queue
}
```

**Solution B — Distinguish 5xx from connectivity**

A 5xx is a *reply from the server* (it is reachable), so it should not be
treated identically to a dropped connection. Give 5xx its own bounded retry
budget that dead-letters, while a genuine network error (no response) keeps the
current "retry until online" behavior:

```ts
function classify(err: unknown): 'terminal' | 'server' | 'connectivity' {
  if (err instanceof ApiError) {
    if (err.status === 408 || err.status === 429) return 'connectivity';
    if (err.status >= 500) return 'server';        // reachable but failing
    if (err.status >= 400) return 'terminal';       // client error
  }
  return 'connectivity';                             // no response at all
}
```

Then bound `server` retries (e.g. 3 attempts) before dead-lettering, and keep
`connectivity` unbounded.

**Solution C — Head-of-line bypass**

Instead of strict FIFO, skip an event that has exceeded a soft attempt threshold
and try the next one, marking the skipped event as `failed`. Best combined with
issue #6 (causal dependency quarantine) so dependents are not applied against a
missing row.

Recommended: **A + B together** — reclassify 5xx *and* cap attempts as a
backstop.

---

## 2. No timeout on the write request

**Severity: Critical**

`api()` (`api.ts:23`) calls `fetch` with no `AbortController`/timeout. The pump
`await`s that fetch (`syncEngine.ts:141`). A half-open TCP connection (mobile
network switch, laptop sleep, Wi-Fi drop where `navigator.onLine` stays `true`)
leaves the fetch hanging indefinitely, and the pump blocks **forever** with the
event stuck `inflight`. Only a reload (→ `recoverInflight`) frees it. The read
stream has `waitUntilOnline`, but the write path has no equivalent guard.

**Failure scenario**
1. Pump sends an event; mid-request the network silently dies (no RST).
2. `fetch` never resolves or rejects.
3. Pump is parked on the `await`. No further writes drain. No error surfaces.

**Solution A — Per-request timeout via `AbortSignal.timeout` (recommended)**

```ts
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  const token = auth.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  // ...
}
```

A timeout aborts as an `AbortError` (not an `ApiError`), so `isTerminal` returns
`false` → it is retried as connectivity. That is the desired behavior.

**Solution B — Combine caller and timeout signals**

If the pump ever needs to cancel in-flight work (e.g. on logout), combine
signals with `AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])` so
both a manual abort and a timeout tear the request down.

---

## 3. The queue is global, not scoped to a user

**Severity: High**

`eventStore.ts` opens a single Dexie DB (`web2-sync`) with no `userId` on events,
and `initSyncEngine()` runs at module load (`main.tsx:11`) using whatever token
is current when the pump fires. On a shared device the queue can drain under the
wrong identity.

**Failure scenario**
1. User A queues writes while offline.
2. A logs out; user B logs in on the same browser.
3. The pump drains A's commands with **B's** token.
4. `applyTodoInsert` forces `userId: actor.id` (`services/todos.ts:31`), so A's
   todos are created under **B's** account. Silent cross-user attribution.

**Solution A — Namespace the queue per user (recommended)**

Include the user id in the Dexie database name (or as an indexed column), and
only pump events belonging to the current user:

```ts
// One physical DB per user id — fully isolates queues.
function dbNameFor(userId: string) {
  return `web2-sync:${userId}`;
}
```

or keep one DB but stamp and filter:

```ts
interface StoredEvent {
  // ...
  ownerId: string; // the user who enqueued it
}
// nextPending(): where('status').equals('pending') AND ownerId === auth.user.id
```

**Solution B — Clear the queue on logout**

In `auth.clear()` (or the logout handler in `_authed.tsx`), flush the Dexie
store. Simpler, but **loses un-synced offline writes** on logout — only
acceptable if that trade-off is explicit.

**Solution C — Refuse to drain under a mismatched identity**

Stamp each event with `ownerId` at enqueue time and have the pump `skip`/hold any
event whose `ownerId !== auth.user?.id`. Preserves A's writes until A logs back
in. Best correctness, slightly more logic.

Recommended: **A** (per-user namespacing) — strongest isolation with no data loss.

---

## 4. Token expiry dead-letters the whole queue and silently logs the user out

**Severity: High**

On a background retry, an expired JWT produces a 401. `api()` then calls
`auth.clear()` (`api.ts:26`), logging the user out mid-session with no
interaction. Worse, `isTerminal(401)` is `true` (`syncEngine.ts:108`), so the
event is **dead-lettered** — and every following pending event also 401s and
dead-letters. A single token expiry during a drain turns the entire pending queue
into "failed" events requiring manual per-event Retry.

**Failure scenario**
1. Token expires while several writes are queued.
2. Pump sends event 1 → 401 → `auth.clear()` + dead-letter.
3. Pump continues to event 2 → 401 → dead-letter … the whole queue is now failed.
4. User is bounced to `/login` with a pile of "failed" writes.

**Solution A — Treat 401 as pause-and-reauth, not terminal (recommended)**

Make 401 a distinct, non-terminal outcome that halts the pump without
dead-lettering, and resume after re-authentication:

```ts
function isAuthExpiry(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// in pump():
if (isAuthExpiry(err)) {
  await markPending(ev.localId, 'auth expired');
  setStatus('offline');   // or a dedicated 'unauthenticated' status
  break;                  // stop draining; do NOT dead-letter
}
```

Then call `pump()` again after a successful login.

**Solution B — Refresh tokens / silent re-auth**

Add a refresh-token flow so an expired access token is renewed transparently and
the retry succeeds without user interaction. Larger change, but the correct
long-term answer; the current 7-day static JWT (`api/src/auth.ts:5`) has no
renewal path.

**Solution C — Decouple `auth.clear()` from background requests**

Only clear auth / redirect on a 401 that originates from a *user-initiated*
request, not from the background sync pump. Pass a flag through `api()` (e.g.
`{ background: true }`) so the pump's 401s pause instead of logging out.

Recommended: **A** now, **B** later.

---

## 5. The read path has none of the write path's security

**Severity: High**

The write path is carefully authorized (owner-scoped todos, admin-gated users).
But the collections read **directly from Electric** (`electric.ts:3`,
`http://localhost:3010/v1/shape`) with **no auth** and **no row filter**:
`todoCollection` requests `params: { table: 'todos' }` — the *entire* table
(`collections/todos.ts:30`). Every client streams **every user's todos**. The
`users` shape at least drops `pin_hash` (`collections/users.ts:41`), but todos
leak cross-user wholesale, and the Electric port is reachable without a token.

**Failure scenario**
- Any authenticated user (or anyone who can reach port 3010) receives all users'
  todos in their local collection.

**Solution A — Put an authenticating proxy in front of Electric (recommended)**

Route shape requests through the API instead of hitting Electric directly. The
proxy validates the JWT and injects a server-controlled `where` clause so a user
only receives their own rows:

```
Browser → GET /api/shape/todos (Bearer token)
        → API validates token, forwards to Electric with where=user_id='<actor>'
        → streams filtered shape back
```

Point `ELECTRIC_URL` at `/api/shape/...` and set `params`/`where` server-side so
the client cannot widen the scope. This is the ElectricSQL-recommended pattern
(gatekeeper / proxy auth).

**Solution B — Signed shape parameters (gatekeeper tokens)**

Have the API mint a short-lived signed token that encodes the allowed
table/columns/where, and have Electric validate it. Keeps Electric in the
request path but prevents clients from forging a broader shape.

**Solution C — Per-user `where` on the shape (defense in depth, not sufficient alone)**

Add `where: "user_id = '<id>'"` to the todo shape params. This stops the *app*
from surfacing other rows, but because the client controls the parameter and
Electric is unauthenticated, it is trivially bypassed — only meaningful combined
with A or B.

Recommended: **A** — a validating proxy is the only option that actually enforces
read authorization.

---

## 6. One dead-lettered event + dependent successors = silent data loss

**Severity: Medium**

When an event dead-letters (terminal 4xx), the pump `continue`s
(`syncEngine.ts:154`) to the next event even if it causally depends on the failed
one.

**Failure scenario**
1. `insert todo A` dead-letters (terminal error).
2. `update todo A` is queued behind it.
3. Pump proceeds to the update; `applyTodoUpdate` matches no row → returns `null`
   → treated as an already-applied no-op → event removed.
4. The update **silently vanishes**.
5. Later "Retry" on the failed insert re-creates A with the *original* title,
   losing the edit.

**Solution A — Quarantine dependents of a dead-lettered event (recommended)**

Track a dependency key (e.g. `entity + payload.id`). When an event is dead-lettered,
also mark any queued events sharing that key as `failed` (blocked), so they are not
applied against a missing row and are surfaced together for retry/dismiss.

**Solution B — Fail the whole queue-tail on terminal error**

Simpler but blunter: on a terminal failure, stop draining and mark the run
`offline`/blocked until the user resolves the dead-letter. Prevents silent loss at
the cost of halting unrelated writes.

**Solution C — Make no-op-on-missing-row a signal, not a success**

Have the services distinguish "matched no row because it never existed" from
"already applied." An update/delete for an id that has no corresponding processed
insert could be re-queued or flagged rather than silently removed.

Recommended: **A** — quarantine by `(entity, id)`.

---

## 7. Multi-tab: shared queue, per-tab pump, no leader election

**Severity: Medium**

The Dexie DB is shared across all tabs of the origin, but `pumping` and
`backoffIndex` are per-tab module state (`syncEngine.ts:124`). Two open tabs both
`nextPending()` the same event, both `markInflight` (no atomic compare-and-swap),
and both POST it. The server idempotency ledger (`events.ts:71`) prevents
double-*apply*, so there is no corruption — but there are redundant sends and,
via issue #8, spurious 500s that can kick one tab into a needless offline/backoff
cycle.

**Solution A — Web Locks leader election (recommended)**

Gate the pump on a `navigator.locks` lock so only one tab drains at a time:

```ts
function pump(): Promise<void> {
  return navigator.locks.request('web2-sync-pump', { ifAvailable: true }, async (lock) => {
    if (!lock) return;      // another tab holds it
    await drain();          // the existing pump loop body
  });
}
```

**Solution B — BroadcastChannel leader election**

Elect a leader tab via `BroadcastChannel` and have only the leader run the pump;
re-elect on `visibilitychange`/`unload`. More code than Web Locks but works where
Web Locks is unavailable.

**Solution C — Atomic claim in the store**

Make `markInflight` a conditional update ("set inflight only if still pending")
so a losing tab cannot claim an event another tab already took. Reduces double
sends but does not stop two pumps from thrashing.

Recommended: **A** — Web Locks is purpose-built for exactly this.

---

## 8. Idempotency ledger check is not concurrency-safe

**Severity: Medium**

`events.ts:71` does SELECT-then-INSERT on `processed_events` inside a READ
COMMITTED transaction. Two concurrent POSTs of the same `cmd.id` (a retry racing
an in-flight send, or two tabs per issue #7) both SELECT empty, both `dispatch`,
and the loser's `INSERT` hits the primary key and throws — but as a raw error,
not a `ServiceError`, so it escapes as a **500** (misclassified as connectivity
per issue #1). It self-heals on the next retry (now "seen"), but the 500 is noise
and can trigger a needless backoff.

**Solution A — `onConflictDoNothing` on the ledger insert, then re-read (recommended)**

```ts
const inserted = await tx
  .insert(processedEvents)
  .values({ id: cmd.id, /* ... */, txid })
  .onConflictDoNothing({ target: processedEvents.id })
  .returning();

if (!inserted.length) {
  // someone else recorded it first — return the winner's txid
  const [seen] = await tx.select().from(processedEvents).where(eq(processedEvents.id, cmd.id));
  return { txid: seen.txid };
}
```

Note the ordering problem: the `dispatch` side effects still run twice in this
shape. To make the whole thing exactly-once, insert the ledger row **first**
(claim the id via `onConflictDoNothing`); only run `dispatch` if the claim
succeeded, otherwise short-circuit to the existing txid.

**Solution B — Serialize per event id with an advisory lock**

`SELECT pg_advisory_xact_lock(hashtext(cmd.id))` at the top of the transaction so
concurrent duplicates queue rather than race. Simple, but adds a lock round-trip
per command.

**Solution C — Rely on serialization from single-writer**

If issue #7 is fixed (one pump across tabs) and issue #1's retry never overlaps an
in-flight send, concurrent duplicates for the same id become vanishingly rare.
Lower-effort but leaves the race latent.

Recommended: **A** (claim-first ledger insert) for true exactly-once dispatch.

---

## 9. Minor / latent

- **txid precision** (`txid.ts:15`): `pg_current_xact_id()::xid::text` truncates
  the 64-bit fullxid to a 32-bit `xid` that wraps at ~4B, and `Number.parseInt`
  would lose precision above 2^53 regardless. Fine for a POC, latent for a
  long-lived database.
  *Solution:* keep the fullxid as a string/BigInt end-to-end and match on that,
  or accept the POC limitation explicitly.

- **FIFO ordering is implicit** (`eventStore.ts:54`): `nextPending` relies on
  Dexie returning the lowest `localId` for an equality match on the `status`
  index rather than an explicit order.
  *Solution:* `where('status').equals('pending').sortBy('localId')` (or an
  explicit compound index) so ordering is guaranteed by contract, not by
  incidental behavior.

- **Empty update patch** (`services/todos.ts:52`, `services/users.ts:52`): an
  update whose `changes` contain no recognized field yields `set({})` → Drizzle
  error → 500 → poison per issue #1.
  *Solution:* if the patch is empty, return the existing row as a no-op instead
  of issuing the update.

- **Retry loses optimistic feedback** (`syncEngine.ts:59`): after a reject the
  resolver is deleted from the in-memory `pending` map, so a later `retryEvent`
  success has no resolver to settle and reconciles only via the shape stream.
  Harmless; note it if optimistic UX on retry is desired.

---

## Priority order

| # | Issue | Severity | Recommended fix |
|---|-------|----------|-----------------|
| 1 | Poison message stalls queue forever | Critical | Attempt cap + reclassify 5xx |
| 2 | No write-request timeout | Critical | `AbortSignal.timeout` in `api()` |
| 3 | Queue not scoped to user | High | Per-user Dexie namespace |
| 4 | Token expiry dead-letters queue + silent logout | High | 401 = pause-and-reauth |
| 5 | Read path unauthenticated / whole table | High | Authenticating shape proxy |
| 6 | Dead-letter + dependents = silent loss | Medium | Quarantine by `(entity, id)` |
| 7 | Multi-tab double-drain | Medium | Web Locks leader election |
| 8 | Ledger race → spurious 500 | Medium | Claim-first `onConflictDoNothing` |
| 9 | txid / ordering / empty-patch / retry UX | Minor | See above |

**Fix #1 and #2 first** — together they are the difference between "self-heals"
and "silently wedged forever." **#3 and #5** are the security-correctness gaps
worth closing before this leaves POC status.
