import { createCollection } from '@tanstack/react-db';
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection';
import { z } from 'zod';
import { db, APP_SCHEMA } from '@/lib/powersync';

/**
 * Todos as an optimistic TanStack DB collection backed by PowerSync (option 3:
 * SQLite input types transformed into rich output types).
 *
 * SQLite has no boolean/timestamp types, so the raw row stores `completed` as an
 * integer (0/1) and `created_at` as ISO text. The `schema` below deserialises
 * those into a real `boolean` and `Date` on read; the `serializer` converts them
 * back to SQLite-compatible values on write. Mutations are captured in
 * PowerSync's local CRUD queue and uploaded to `/api/data` by the connector.
 */
const todoSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  completed: z.number().transform((value) => value > 0),
  created_at: z.string().transform((value) => new Date(value)),
});

/** A todo as read from the collection (rich output types). */
export type Todo = z.output<typeof todoSchema>;

export const todoCollection = createCollection(
  powerSyncCollectionOptions({
    database: db,
    table: APP_SCHEMA.props.todos,
    schema: todoSchema,
    onDeserializationError: (error) => {
      console.error('[todos] failed to deserialize a synced row', error);
    },
    serializer: {
      completed: (value) => (value ? 1 : 0),
      created_at: (value) => value.toISOString(),
    },
  }),
);
