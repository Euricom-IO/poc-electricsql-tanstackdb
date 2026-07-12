# Partitioning Design

This document describes how to add PostgreSQL partitioning later for the `event_processing_log` table in a generic offline-first sync engine. The goal is to keep pruning cheap, retention predictable, and operational queries fast without coupling partitioning logic into the application layer.[cite:142][cite:151][cite:152]

## Why partition this table

`event_processing_log` is operational telemetry, not authoritative business state. It grows continuously, is queried mostly by recent time windows, and usually has a much shorter retention requirement than `inbound_events` or `event_decisions`.[cite:142][cite:148] Because of that shape, it is a strong fit for time-based range partitioning on `created_at`, where old data can be removed by dropping partitions rather than deleting rows in place.[cite:142][cite:152]

Large row-by-row deletes on append-heavy log tables create dead tuples, autovacuum pressure, and table bloat. Time partitioning avoids most of that cost because retention becomes a metadata operation instead of a mass delete.[cite:142][cite:152]

## Scope

This design applies only to:

- `event_processing_log`

It does not require partitioning for:

- `inbound_events`, unless volume becomes large and retention is short.[cite:142]
- `event_decisions`, because those records are more authoritative and may need longer retention than the processing log.[cite:148]

## Design goals

- Fast pruning with minimal vacuum cost.[cite:142][cite:152]
- Predictable retention windows aligned to operational debugging needs.[cite:142][cite:144]
- Normal application queries still go through the parent table, so partitioning remains mostly invisible to the service layer.[cite:151]
- Ability to adopt later with raw SQL migrations, because Drizzle does not currently provide first-class schema DSL support for Postgres partition definitions.[cite:151]

## Partitioning strategy

The recommended strategy is native PostgreSQL range partitioning on `created_at`.[cite:138][cite:152]

### Partition key

Use `created_at timestamptz` as the partition key. The processing log is append-only and nearly all retention and support queries are time-based, so this key naturally matches the workload.[cite:142][cite:152]

### Partition interval

Choose the interval by expected write volume:

| Volume profile | Recommended partition size | Why |
|---|---|---|
| Low to moderate volume | Monthly | Fewer partitions, simpler maintenance.[cite:142][cite:152] |
| High volume | Daily | Smaller partitions, faster drop and tighter retention control.[cite:141][cite:149] |

A practical default is monthly partitions until the table reaches multi-million-row monthly growth, then reassess daily partitions.[cite:141][cite:149]

## Table shape

The parent table should be narrow and include only the fields needed for support, tracing, and debugging.[cite:137][cite:144]

Recommended columns:

- `id`
- `event_id`
- `stage`
- `data`
- `created_at`

Recommended rule: do not copy large payloads into the processing log unless they are needed for forensic diagnostics, because log tables grow very quickly and large JSON payloads increase storage and I/O costs.[cite:137][cite:144]

## Constraint design

For partitioned tables in Postgres, any primary key or unique constraint enforced across partitions must include the partition key. Because of that, the parent table should use a composite primary key such as `(id, created_at)` instead of only `id`.[cite:138][cite:152]

Recommended keys and indexes:

- Primary key: `(id, created_at)`.[cite:138][cite:152]
- Support index: `(event_id, created_at)` for event timelines.[cite:145]
- Optional support index: `(stage, created_at)` if stage-based investigation is common.[cite:145]

Avoid indexing every column. Local indexes on many partitions add maintenance cost and usually provide little value for a short-retention log table.[cite:137][cite:144]

## Application integration with Drizzle

The application can continue to model `event_processing_log` as a normal Drizzle table for querying. Partitioning should be introduced through raw SQL migrations rather than relying on Drizzle schema DSL, because Drizzle discussion and release material indicate that first-class partition schema support is not currently the standard path.[cite:151]

That means:

- Keep the table in Drizzle schema for type-safe queries.[cite:151]
- Create the physical partitioned table using SQL migration files.[cite:151][cite:155]
- Maintain partitions through SQL functions, scheduled jobs, or `pg_partman`.[cite:154][cite:160][cite:163]

## Suggested migration pattern

When partitioning is introduced later, the recommended rollout is:

1. Create a new partitioned parent table with the final schema.[cite:152]
2. Create current and future partitions in advance.[cite:152]
3. Copy or backfill any retained rows from the old non-partitioned table if needed.[cite:152][cite:159]
4. Swap reads and writes to the new table in a controlled migration window.[cite:159]
5. Drop or archive the old table after verification.[cite:159]

If the table is still relatively small at rollout time, a simple cutover is easier than trying to perform a zero-downtime repartitioning migration.[cite:159]

## Partition lifecycle

Partitioning only works well when lifecycle automation is part of the design.[cite:154][cite:160]

### Create future partitions

Always create future partitions ahead of time. This avoids runtime insert failures when the clock crosses a partition boundary and no child partition exists.[cite:152]

Recommended policy:

- Ensure the current partition exists.
- Pre-create at least the next 2 partitions.[cite:152]

### Prune old partitions

Retention should remove whole partitions rather than deleting individual rows. Dropping or detaching an old partition is far cheaper than `DELETE WHERE created_at < cutoff` because it avoids dead tuple cleanup and bloat.[cite:142][cite:152]

Recommended retention starting point:

| Table | Suggested retention | Reason |
|---|---|---|
| `event_processing_log` | 14 to 30 days | Enough for operational debugging and support in most sync engines.[cite:142][cite:148] |
| `event_decisions` | 60 to 180 days | Authoritative decision receipts may be needed longer.[cite:148] |
| `inbound_events` | Case-specific | Depends on replay and audit requirements.[cite:148] |

### Archive vs drop

Use one of these two strategies:

- Drop old partitions immediately when no longer needed operationally.[cite:142]
- Detach and archive them first if compliance or forensic requirements exist.[cite:139][cite:144]

For a generic sync engine, dropping is usually enough unless the processing log is being treated as an audit artifact, which it generally should not be.[cite:142][cite:148]

## Operational maintenance options

There are two good options.

### Option A: Native SQL + scheduled jobs

Use custom SQL functions plus a scheduler such as `pg_cron` or an external maintenance worker to:

- create future partitions,
- drop old partitions,
- and alert on partition drift.[cite:140][cite:152]

This is simple, transparent, and a good fit when there are only a few partitioned tables.[cite:140][cite:152]

### Option B: pg_partman

Use `pg_partman` if the system will manage multiple time-partitioned tables or if automated retention and partition creation should live entirely inside Postgres. `pg_partman` is specifically designed to manage time-based partition lifecycle and retention policies.[cite:153][cite:154][cite:160][cite:163]

`pg_partman` is a strong choice if the project expects several append-only operational tables, because it removes a lot of custom maintenance code.[cite:154][cite:160][cite:163]

## Query behavior

Application queries should continue to hit the parent table. Postgres handles partition pruning automatically when the query includes a usable `created_at` predicate, so recent-window support queries remain efficient without the application naming child tables explicitly.[cite:138][cite:145]

Recommended query style:

- Filter by recent time window whenever possible.[cite:145]
- Add `event_id` and `created_at` predicates for timeline views.[cite:145]
- Avoid full-history scans across all partitions for support dashboards.[cite:145]

## Risks and trade-offs

Partitioning is operationally valuable, but it adds schema and maintenance complexity.[cite:141][cite:150]

Main trade-offs:

- More DDL and migration complexity.[cite:151][cite:159]
- More objects in the database, especially with daily partitions.[cite:141][cite:149]
- Careful index discipline is required to avoid overhead.[cite:137][cite:144]
- Primary and unique constraints must be designed with the partition key included.[cite:138][cite:152]

For that reason, partitioning should be added when the log table size or retention pressure justifies it, not just because the feature exists.[cite:142][cite:150]

## Recommended default for later adoption

If this is added later, the recommended starting configuration is:

- Native Postgres range partitioning on `created_at`.[cite:138][cite:152]
- Monthly partitions.[cite:142][cite:152]
- 30-day retention for `event_processing_log`.[cite:142][cite:148]
- Raw SQL migrations alongside Drizzle schema.[cite:151]
- `pg_partman` only if more partitioned tables are introduced or database-managed retention is preferred.[cite:154][cite:160][cite:163]

This gives most of the pruning benefit with relatively low operational complexity.[cite:142][cite:152]
