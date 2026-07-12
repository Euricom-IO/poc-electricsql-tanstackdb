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

### 2. Shared proxy helper

New file `packages/api/src/routes/shape.ts`. One helper does param filtering +
streaming; per-shape config supplies table / where / columns / authz.

```ts
import { Hono } from 'hono';
import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from '@electric-sql/client';
import type { AppEnv } from '../auth';
import { authMiddleware, adminOnly } from '../middleware/auth';

export const shapeRoutes = new Hono<AppEnv>();

const UPSTREAM = process.env.ELECTRIC_UPSTREAM_URL ?? 'http://localhost:3010/v1/shape';

/**
 * Reverse-proxy a shape request to Electric. The client controls only Electric
 * protocol params (offset/handle/live/cursor/…); the caller pins everything
 * that governs *what* data is returned (table, where, columns, params).
 */
async function proxyShape(
  reqUrl: string,
  pin: (u: URL) => void,
): Promise<Response> {
  const incoming = new URL(reqUrl);
  const upstream = new URL(UPSTREAM);

  // Forward ONLY protocol params. table/where/columns/params are reserved PG
  // params and are never in this list, so a client cannot smuggle them in.
  for (const key of ELECTRIC_PROTOCOL_QUERY_PARAMS) {
    const v = incoming.searchParams.get(key);
    if (v !== null) upstream.searchParams.set(key, v);
  }

  pin(upstream); // server-controlled table / where / columns / params

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

shapeRoutes.get('/todos', authMiddleware, (c) => {
  const actor = c.get('user');
  return proxyShape(c.req.url, (u) => {
    u.searchParams.set('table', 'todos');
    u.searchParams.set('where', 'user_id = $1');
    u.searchParams.set('params[1]', actor.id);
  });
});

shapeRoutes.get('/users', authMiddleware, adminOnly, (c) =>
  proxyShape(c.req.url, (u) => {
    u.searchParams.set('table', 'users');
    // Enforce the pin_hash exclusion server-side.
    u.searchParams.set('columns', 'id,name,role,created_at');
  }),
);
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

### 3. Mount the routes

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
3. Create `packages/api/src/routes/shape.ts` (`proxyShape` helper + `/todos`, `/users` routes).
4. Mount `app.route('/api/shape', shapeRoutes)` in `src/index.ts`.
5. `web2`: replace `ELECTRIC_URL` with `SHAPE_URL` + `authHeaders`; wire `headers`/`onError` into both collections; keep `fetchClient`/`backoffOptions`.
6. Remove the client `params.table` / `columns` (now server-pinned).
7. Update `docker-compose.yml` for prod (secret + no public `3010`) — or note it as a follow-up if the POC stays insecure locally.
8. Update `README.md` (web2 sync architecture + security note now reflect the authenticated proxy).

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

- **Todo scoping:** confirm `web2` should show only own todos (this plan) vs.
  a shared/team view. If shared, replace the `where` with the appropriate
  team/org predicate rather than dropping it.
- **Constant source:** import `ELECTRIC_PROTOCOL_QUERY_PARAMS` (adds a client dep
  to the API) vs. inline a small allowlist (`offset`, `handle`, `live`, `cursor`,
  `source_id`, `replica`, live-cache-buster, log mode). Importing stays correct
  across Electric upgrades.
