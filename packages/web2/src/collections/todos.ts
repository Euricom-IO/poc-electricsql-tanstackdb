import { createCollection } from '@tanstack/react-db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { api } from '@/lib/api';
import { ELECTRIC_URL } from '@/lib/electric';

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
 * stream live from the Electric shape API (the whole `todos` table); writes go
 * through the existing API, which returns the Postgres `txid` so Electric can
 * match each optimistic mutation against the synced row.
 */
export const todoCollection = createCollection(
  electricCollectionOptions<TodoRow>({
    id: 'todos',
    shapeOptions: {
      url: ELECTRIC_URL,
      params: { table: 'todos' },
    },
    getKey: (row) => row.id,
    onInsert: async ({ transaction }) => {
      const row = transaction.mutations[0].modified;
      const { txid } = await api<{ txid: number }>('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ id: row.id, title: row.title }),
      });
      return { txid };
    },
    onUpdate: async ({ transaction }) => {
      const { original, changes } = transaction.mutations[0];
      const { txid } = await api<{ txid: number }>(`/api/todos/${original.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: changes.title, completed: changes.completed }),
      });
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const { original } = transaction.mutations[0];
      const { txid } = await api<{ txid: number }>(`/api/todos/${original.id}`, {
        method: 'DELETE',
      });
      return { txid };
    },
  }),
);
