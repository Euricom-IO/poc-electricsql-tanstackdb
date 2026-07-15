import { createCollection } from '@tanstack/react-db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { submitCommand } from '@/lib/syncEngine';
import { ELECTRIC_URL, electricFetch, ELECTRIC_BACKOFF } from '@/lib/electric';

/**
 * A todo row as it arrives from the ElectricSQL shape stream: raw Postgres
 * column names (snake_case), not the API's camelCase DTO.
 */
export type TodoRow = {
  id: string;
  user_id: string;
  title: string;
  completed: boolean;
  created_at: string;
};

/**
 * Todos as an optimistic TanStack DB collection backed by ElectricSQL. Reads
 * stream live from the Electric shape API (the whole `todos` table); writes are
 * captured as durable, offline-tolerant commands by the sync engine, which posts
 * them to /api/events and resolves each handler with the Postgres `txid` so
 * Electric can match the optimistic mutation against the synced row.
 */
export const todoCollection = createCollection(
  electricCollectionOptions<TodoRow>({
    id: 'todos',
    shapeOptions: {
      url: ELECTRIC_URL,
      params: { table: 'todos' },
      // Resume the read stream immediately on reconnect (see lib/electric.ts).
      fetchClient: electricFetch,
      backoffOptions: ELECTRIC_BACKOFF,
    },
    getKey: (row) => row.id,
    onInsert: ({ transaction }) => {
      const row = transaction.mutations[0].modified;
      return submitCommand({
        entity: 'todo',
        op: 'insert',
        payload: { id: row.id, title: row.title },
      });
    },
    onUpdate: ({ transaction }) => {
      const { original, changes } = transaction.mutations[0];
      return submitCommand({
        entity: 'todo',
        op: 'update',
        payload: { id: original.id, title: changes.title, completed: changes.completed },
      });
    },
    onDelete: ({ transaction }) => {
      const { original } = transaction.mutations[0];
      return submitCommand({
        entity: 'todo',
        op: 'delete',
        payload: { id: original.id },
      });
    },
  }),
);
