# poc-electricsql-tanstackdb

A Bun monorepo POC: a multi-user todo app with a React SPA, a Hono API, and a
Drizzle/Postgres data layer.

## Packages

```
packages/
  db     @app/db   Drizzle schema, migrations, seed, DB client (Postgres)
  api    @app/api  Hono HTTP API + JWT auth (depends on @app/db)
  web    @app/web  React SPA — TanStack Router, TanStack DB, shadcn/ui, Tailwind 4
```

Bun workspaces only (no Turborepo). Root scripts fan out with `bun run --filter`.

## Stack

- **Runtime / package manager:** Bun
- **Web:** React 19, TanStack Router (file-based), TanStack DB (query collections),
  shadcn/ui, Tailwind CSS 4
- **API:** Hono, `hono/jwt` (HS256)
- **DB:** PostgreSQL via Docker, Drizzle ORM + drizzle-kit
- **Lint / format:** [Vite+](https://viteplus.dev/guide/) (`vp lint` / `vp fmt` / `vp check`)

## Getting started

```bash
bun install          # install all workspaces
cp .env.example .env # DATABASE_URL, JWT_SECRET, ports

bun run db:up        # start Postgres (docker compose)
bun run db:migrate   # apply migrations
bun run db:seed      # create the initial admin user

bun run dev          # start API (:3000) and web (:5173) together
```

Open http://localhost:5173 and sign in.

### Initial admin

| Name  | PIN     | Role  |
| ----- | ------- | ----- |
| peter | `12345` | admin |

## How it works

- **Login** is name + PIN. The API verifies the PIN (hashed with `Bun.password`)
  and returns a 7-day JWT signed with `JWT_SECRET`. The SPA stores it in
  `localStorage` and sends it as `Authorization: Bearer <token>`.
- **Auth guarding** happens both in the router (`beforeLoad` redirects) and in the
  API (`authMiddleware` / `adminOnly`).
- **Todos** and **users** both use fully optimistic TanStack DB query collections
  ([todos](packages/web/src/collections/todos.ts),
  [users](packages/web/src/collections/users.ts)): `insert`/`update`/`delete` apply
  instantly and are persisted through the API's `onInsert`/`onUpdate`/`onDelete`
  handlers, rolling back if the request fails (e.g. a duplicate user name → 409).
  The user collection carries a write-only `pin` field (never returned by the API).
- **Admin** page (admins only) manages users. Only admins can create users
  (enforced by `adminOnly` on `/api/users`).

## Scripts (run from the repo root)

| Script                | Description                              |
| --------------------- | ---------------------------------------- |
| `bun run dev`         | Run API + web dev servers                |
| `bun run dev:api`     | API only (`bun --hot`)                   |
| `bun run dev:web`     | Web only (vite)                          |
| `bun run build`       | Build all packages                       |
| `bun run db:up` / `:down` | Start / stop Postgres                |
| `bun run db:generate` | Generate a migration from the schema     |
| `bun run db:migrate`  | Apply migrations                         |
| `bun run db:seed`     | Seed the initial admin user              |
| `bun run db:studio`   | Open Drizzle Studio                      |
| `bun run lint` / `fmt` / `check` | Vite+ lint / format / full check |

## API

| Method | Path                | Auth        | Description            |
| ------ | ------------------- | ----------- | ---------------------- |
| POST   | `/api/auth/login`   | –           | Log in, returns a JWT  |
| GET    | `/api/auth/me`      | user        | Current user           |
| GET    | `/api/todos`        | user        | List own todos         |
| POST   | `/api/todos`        | user        | Create a todo          |
| PATCH  | `/api/todos/:id`    | user        | Update own todo        |
| DELETE | `/api/todos/:id`    | user        | Delete own todo        |
| GET    | `/api/users`        | admin       | List users             |
| POST   | `/api/users`        | admin       | Create a user          |
| PATCH  | `/api/users/:id`    | admin       | Update a user          |
| DELETE | `/api/users/:id`    | admin       | Delete a user          |

## Notes

- Sync strategy is **API query collections** (TanStack DB backed by the Hono API).
  Both todos and users are optimistic collections with `onInsert`/`onUpdate`/`onDelete`
  handlers. The `@app/db` package keeps schema and DTO types separate
  (`@app/db/types` has no runtime deps) so ElectricSQL could be dropped in later
  without restructuring.
- This is a POC: the JWT secret is a shared string, PIN is the only credential, and
  the token lives in `localStorage`. Harden before any real use.
