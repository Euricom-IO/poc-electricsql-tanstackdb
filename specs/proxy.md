# Plan: Authenticated Electric shape proxy in the API

Integrate ElectricSQL's [proxy-auth pattern](https://electric.ax/docs/sync/guides/auth#proxy-auth)
so that `web2`'s read path is authenticated and scoped per user, instead of the
browser talking to Electric directly in insecure mode.

## Current state

- `web2` collections read directly from Electric at `http://localhost:3010/v1/shape`
  ([`lib/electric.ts`](packages/web2/src/lib/electric.ts)).
- Electric runs with `ELECTRIC_INSECURE=true` (see [`docker-compose.yml`](docker-compose.yml)),
  so **reads are unauthenticated and unscoped**: any client can read every user's
  todos and the full user list. Only `pin_hash` is withheld (client-supplied
  `columns`), which is a client-side choice the server does not enforce.
- Writes already go through the authenticated `POST /api/events` path, so this
  plan only concerns the **read** path.

## Target architecture

The browser never talks to Electric. It talks to the API, which authenticates
the request, pins the shape parameters server-side, and reverse-proxies to
Electric.

```
web2 collection
  → GET /api/shape/todos   (Authorization: Bearer <jwt>)   [same origin]
      → authMiddleware verifies JWT → actor
      → build upstream: ELECTRIC_UPSTREAM_URL
          + forwarded protocol params (offset, handle, live, cursor, …)
          + table   = 'todos'          (server-pinned)
          + where   = 'user_id = $1'    (server-pinned)
          + params[1] = actor.id
      → fetch(upstream) and stream the response body back verbatim
```

Two shapes, two routes, differing authorization:

| Route              | Auth        | table   | Server-pinned scope / columns                          |
| ------------------ | ----------- | ------- | ------------------------------------------------------ |
| `GET /api/shape/todos` | user    | `todos` | `where user_id = $1` bound to actor → own todos only   |
| `GET /api/shape/users` | **admin** | `users` | `columns` = `id,name,role,created_at` (no `pin_hash`)  |

> **Intentional behavior change:** today `web2` shows *all* todos. After this
> change it shows only the signed-in user's todos — matching the REST `web` app
> (`GET /api/todos` is already actor-scoped in
> [`services/todos.ts`](packages/api/src/services/todos.ts)). This is the point
> of the change; call it out in the PR.

## Server changes (`packages/api`)

### 1. Config / env

Add to the API's environment:

- `ELECTRIC_UPSTREAM_URL` — internal Electric shape endpoint, default
  `http://localhost:3010/v1/shape` in dev, `http://electric:3000/v1/shape`
  inside docker. **Not** exposed to the browser.
- `ELECTRIC_SECRET` (production) — sent to Electric so only the proxy can reach
  it once `ELECTRIC_INSECURE` is turned off.

### 2. Role-aware auth middleware

Replace the separate `authMiddleware` + `adminOnly` pair with a single
**factory** `authMiddleware(minRole?)` so a route declares its requirement in one
call — e.g. `authMiddleware(cfg.authz)` in the shape loop below.

Rewrite [`src/middleware/auth.ts`](packages/api/src/middleware/auth.ts):

```ts
import { createMiddleware } from 'hono/factory';
import { verifyToken, type AppEnv, type AuthUser } from '../auth';
import type { Role } from '@app/db/types';

// Roles are a hierarchy: admin outranks user. A route asks for a MINIMUM role.
const ROLE_RANK: Record<Role, number> = { user: 0, admin: 1 };

/**
 * Authenticate via Bearer JWT and enforce a minimum role.
 *   authMiddleware()        → any valid token (was: bare `authMiddleware`)
 *   authMiddleware('admin') → valid token AND admin (was: `authMiddleware, adminOnly`)
 * `authMiddleware('user')` still admits admins, so scoping a shape to `'user'`
 * never locks an admin out of their own rows.
 */
export function authMiddleware(minRole: Role = 'user') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let user: AuthUser;
    try {
      const payload = await verifyToken(header.slice(7));
      user = { id: payload.sub, name: payload.name, role: payload.role };
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
      return c.json({ error: `Forbidden: requires ${minRole}` }, 403);
    }
    c.set('user', user);
    await next();
  });
}
```

**Migration ripple** — `authMiddleware` is now a factory, so every existing call
site must call it. `adminOnly` is deleted.

| File | Before | After |
| ---- | ------ | ----- |
| [`routes/events.ts`](packages/api/src/routes/events.ts) | `use('*', authMiddleware)` | `use('*', authMiddleware())` |
| [`routes/todos.ts`](packages/api/src/routes/todos.ts) | `use('*', authMiddleware)` | `use('*', authMiddleware())` |
| [`routes/auth.ts`](packages/api/src/routes/auth.ts) | `get('/me', authMiddleware, …)` | `get('/me', authMiddleware(), …)` |
| [`routes/users.ts`](packages/api/src/routes/users.ts) | `use('*', authMiddleware, adminOnly)` | `use('*', authMiddleware('admin'))` |

### 3. Shared proxy helper

New file `packages/api/src/routes/shape.ts`. Shapes are declared in a single
`SHAPES` table (`table` / `columns` / `scope` / `authz`); one helper filters
params, streams, and **derives the per-user `where` + `params` automatically**
from each shape's `scope` column. Routes are registered by iterating the table,
so adding a shape is one config entry — no hand-written `where`/`params`.

```ts
import { Hono } from 'hono';
import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from '@electric-sql/client';
import type { AppEnv, AuthUser } from '../auth';
import type { Role } from '@app/db/types';
import { authMiddleware } from '../middleware/auth';

export const shapeRoutes = new Hono<AppEnv>();

const UPSTREAM = process.env.ELECTRIC_UPSTREAM_URL ?? 'http://localhost:3010/v1/shape';

/**
 * Declarative shape definitions. Each entry pins WHAT a shape exposes; the proxy
 * derives the per-user filter from `scope` — no per-route `where`/`params`.
 *
 *  - `table`    reserved PG param, server-pinned.
 *  - `columns`  optional column allowlist (omit → all columns).
 *  - `scope`    column bound to the actor id as `where <scope> = $1`.
 *               REQUIRED and explicit: a real column to scope per-user, or
 *               `null` to declare a shape *intentionally* unscoped (every row).
 *               There is no default, so a new shape cannot silently fail open.
 *  - `authz`    minimum role, passed straight to `authMiddleware`. 'user' =
 *               any authenticated actor (admins included); 'admin' = admin only.
 */
type ShapeConfig = {
  table: string;
  columns?: string[];
  scope: string | null;
  authz: Role;
};

const SHAPES = {
  // Own todos only → where user_id = <actor.id>.
  todos: { table: 'todos', scope: 'user_id', authz: 'user' },
  // Admin-wide user list; pin_hash withheld via the column allowlist.
  users: {
    table: 'users',
    columns: ['id', 'name', 'role', 'created_at'],
    scope: null, // intentionally unscoped — admin sees all users
    authz: 'admin',
  },
} satisfies Record<string, ShapeConfig>;

/** Pin table/columns and, when scoped, BIND the actor id as a query param. */
function pinShape(u: URL, cfg: ShapeConfig, actor: AuthUser): void {
  u.searchParams.set('table', cfg.table);
  if (cfg.columns) u.searchParams.set('columns', cfg.columns.join(','));
  if (cfg.scope !== null) {
    // `cfg.scope` is a server-side constant (never client input). The actor id
    // is bound as a PARAMETER, never interpolated, so it can't alter the query.
    u.searchParams.set('where', `${cfg.scope} = $1`);
    u.searchParams.set('params[1]', actor.id);
  }
}

/**
 * Reverse-proxy a shape request to Electric. The client controls only Electric
 * protocol params (offset/handle/live/cursor/…); table/columns/where/params are
 * pinned from the server-side ShapeConfig.
 */
async function proxyShape(reqUrl: string, cfg: ShapeConfig, actor: AuthUser): Promise<Response> {
  const incoming = new URL(reqUrl);
  const upstream = new URL(UPSTREAM);

  // Forward ONLY protocol params. table/columns/where/params are reserved PG
  // params and are never in this list, so a client cannot smuggle them in.
  for (const key of ELECTRIC_PROTOCOL_QUERY_PARAMS) {
    const v = incoming.searchParams.get(key);
    if (v !== null) upstream.searchParams.set(key, v);
  }

  pinShape(upstream, cfg, actor); // server-controlled table / columns / where / params

  if (process.env.ELECTRIC_SECRET) {
    upstream.searchParams.set('secret', process.env.ELECTRIC_SECRET);
  }

  const res = await fetch(upstream); // long-poll: no client JWT forwarded upstream

  // fetch() decompresses the body but leaves these headers, which would break
  // decoding in the browser. Strip them; keep everything else (electric-handle,
  // electric-offset, electric-schema, electric-cursor, electric-up-to-date…).
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// One route per shape; the shape's `authz` is the minimum role. Scoping/authz
// come from the config, so this loop never needs editing to add a shape.
for (const [name, cfg] of Object.entries(SHAPES)) {
  shapeRoutes.get(`/${name}`, authMiddleware(cfg.authz), (c) =>
    proxyShape(c.req.url, cfg, c.get('user')),
  );
}
```

Notes / gotchas:

- **Streaming.** Returning `new Response(res.body, …)` streams the upstream body
  through Bun without buffering — required for Electric's long-poll (`live=true`,
  ~20s). Do not `await res.text()`.
- **No upstream timeout.** Don't wrap the upstream `fetch` in an `AbortSignal`
  timeout short enough to cut long-polls.
- **Don't forward the JWT upstream.** Electric authorizes the *proxy* (via
  `ELECTRIC_SECRET`), not the end user.
- **`ELECTRIC_PROTOCOL_QUERY_PARAMS`** is exported by `@electric-sql/client` —
  add it as an API dependency (authoritative), or inline the list.
- **Composite / non-equality scopes** (team view, `org_id AND user_id`, ranges)
  don't fit a single `scope` column. Keep `SHAPES` for the common case and add
  an optional escape-hatch field — e.g. `pin?: (u, actor) => void` — for the
  rare shape that needs a hand-written predicate, still param-bound.

### 3a. Security review of automatic scoping

**Verdict: safe to automate — and slightly safer than the hand-written version,
provided `scope` stays required.** The automation only templatizes values that
were *already* server-controlled; it changes none of the trust boundaries.

Why it holds:

- **No identifier injection.** The `where` column comes only from `cfg.scope`, a
  constant in server code. It is never read from the request, headers, or JWT, so
  a client cannot influence which column is filtered.
- **No value injection.** `actor.id` is passed via `params[1]` and bound by
  Postgres, exactly as today — never string-interpolated into the `where`. Even
  if a `sub` claim contained SQL metacharacters it stays inert (and `sub` is a
  server-issued UUID from a signed JWT anyway).
- **Client still can't override the pins.** `table`/`columns`/`where`/`params`
  are reserved PG params, absent from `ELECTRIC_PROTOCOL_QUERY_PARAMS`, and
  `pinShape` runs *after* the forward loop — so a tampered
  `?table=users&where=1=1` is overwritten, unchanged from the explicit design
  (the tamper check in Verification still passes).

The one risk the generic form *introduces* — and how it's neutralized:

- **Fail-open by omission.** With per-route code, a missing `where` is visible in
  the handler. In a config table, a forgotten `scope` on a future shape would
  silently stream every row. This is neutralized by typing `scope: string | null`
  with **no default**: every shape must state either a scope column or an
  explicit `null` ("intentionally all rows"), so omission is a TypeScript error,
  not a data leak. Treat any `scope: null` as a line that needs a reviewer's
  sign-off (pair it with `authz: 'admin'` or a deliberate justification).

No reason to keep it hand-written; adopt the config-driven form with the
required-`scope` guard above.

### 4. Mount the routes

In [`src/index.ts`](packages/api/src/index.ts):

```ts
import { shapeRoutes } from './routes/shape';
app.route('/api/shape', shapeRoutes);
```

`cors()` on `/api/*` already applies; requests are same-origin so this is a no-op
in practice.

## Client changes (`packages/web2`)

### 1. Point collections at the proxy + attach auth

In [`lib/electric.ts`](packages/web2/src/lib/electric.ts): the URL becomes a
same-origin API path (proxied to `:3000` by the vite dev server, same origin in
prod). Drop `VITE_ELECTRIC_URL` / the `:3010` default.

```ts
export const SHAPE_URL = {
  todos: '/api/shape/todos',
  users: '/api/shape/users',
} as const;

// Dynamic so a refreshed/rotated token is always current on reconnect.
export const authHeaders = {
  Authorization: () => {
    const t = auth.token;
    return t ? `Bearer ${t}` : undefined;
  },
};
```

In [`collections/todos.ts`](packages/web2/src/collections/todos.ts) /
[`collections/users.ts`](packages/web2/src/collections/users.ts), update
`shapeOptions`:

```ts
shapeOptions: {
  url: SHAPE_URL.todos,          // was ELECTRIC_URL + params.table
  headers: authHeaders,          // NEW: send the JWT
  fetchClient: electricFetch,    // keep the reconnect fix
  backoffOptions: ELECTRIC_BACKOFF,
  onError: (err) => {            // NEW: token expired mid-stream
    if (err instanceof FetchError && err.status === 401) auth.clear();
    // returning void stops the stream; the router redirects to /login
  },
},
```

- The client-side `params: { table }` and `columns` are removed — the server
  pins them. (Sending them is harmless; the proxy ignores non-protocol params.)
- `fetchClient` (`electricFetch`) and `backoffOptions` from the reconnect fix
  stay; they now wrap the request to the API rather than to Electric.

### 2. Vite proxy

[`vite.config.ts`](packages/web2/vite.config.ts) already proxies `/api` →
`:3000` with `changeOrigin: true`, and http-proxy streams responses, so
long-polls pass through unchanged. No change needed.

## Config / infra changes

- **Dev:** works as-is — API on `:3000` reaches Electric on `:3010`; browser
  reaches only `/api/*`.
- **Production hardening** ([`docker-compose.yml`](docker-compose.yml)):
  - Remove `ELECTRIC_INSECURE=true`; set `ELECTRIC_SECRET` on the Electric
    service and give the API the same secret.
  - Stop publishing Electric's `3010:3000` port; put Electric on the internal
    network only, reachable by the API container (`http://electric:3000`).
  - Serve the SPA behind the same origin as the API so `/api/shape/*` is
    same-origin (no CORS, no token in query string).
- **Caching:** proxied responses are now per-user (the `where` binds to the
  actor). If a CDN/cache sits in front of the API, it must `Vary: Authorization`
  or bypass caching for `/api/shape/*`, otherwise one user could be served
  another's cached shape. No CDN in the POC.

## Task list

1. Add `@electric-sql/client` to `packages/api` deps (for `ELECTRIC_PROTOCOL_QUERY_PARAMS`) or inline the constant.
2. Add `ELECTRIC_UPSTREAM_URL` (+ `ELECTRIC_SECRET` for prod) to API env and `.env.example`.
3. Refactor `src/middleware/auth.ts` to the `authMiddleware(minRole?)` factory; delete `adminOnly`. Update the four call sites (`events.ts`, `todos.ts`, `auth.ts` → `authMiddleware()`; `users.ts` → `authMiddleware('admin')`).
4. Create `packages/api/src/routes/shape.ts` — the `SHAPES` config table, `pinShape` (auto `where`/`params` from `scope`), the `proxyShape` helper, and the route-registration loop using `authMiddleware(cfg.authz)`.
5. Mount `app.route('/api/shape', shapeRoutes)` in `src/index.ts`.
6. `web2`: replace `ELECTRIC_URL` with `SHAPE_URL` + `authHeaders`; wire `headers`/`onError` into both collections; keep `fetchClient`/`backoffOptions`.
7. Remove the client `params.table` / `columns` (now server-pinned).
8. Update `docker-compose.yml` for prod (secret + no public `3010`) — or note it as a follow-up if the POC stays insecure locally.
9. Update `README.md` (web2 sync architecture + security note now reflect the authenticated proxy).

## Verification

- Signed-in **user**: `GET /api/shape/todos?offset=-1` returns only their rows;
  the todos list in `web2` shows only their todos.
- **No/invalid token** on `/api/shape/todos` → `401`; the client's `onError`
  clears auth and the router redirects to `/login`.
- **Non-admin** on `/api/shape/users` → `403`; the collection never populates.
- **Admin** on `/api/shape/users`: rows arrive and contain no `pin_hash`.
- **Tamper check:** `GET /api/shape/todos?table=users&where=1=1` still returns
  only the caller's todos (server pins override client params).
- **Live + reconnect:** a second client's insert appears live; toggling the
  first client offline/online resyncs promptly (reconnect fix intact).
- Direct browser access to Electric is gone (prod: `:3010` not published).

## Open decisions

- **Todo scoping:** confirm `web2` should show only own todos (`scope: 'user_id'`)
  vs. a shared/team view. If shared, this is where the `pin` escape hatch (§3)
  earns its place — a team/org predicate rather than `scope: null` (which would
  expose *all* todos).
- **Constant source:** import `ELECTRIC_PROTOCOL_QUERY_PARAMS` (adds a client dep
  to the API) vs. inline a small allowlist (`offset`, `handle`, `live`, `cursor`,
  `source_id`, `replica`, live-cache-buster, log mode). Importing stays correct
  across Electric upgrades.
