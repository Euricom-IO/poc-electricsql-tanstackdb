import { createCollection } from '@tanstack/react-db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import type { Todo } from '@app/db/types';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';

/**
 * Todos as a fully optimistic TanStack DB collection: reads come from the API
 * via React Query, and insert/update/delete are applied optimistically then
 * persisted through the mutation handlers below.
 */
export const todoCollection = createCollection(
  queryCollectionOptions<Todo>({
    queryClient,
    queryKey: ['todos'],
    queryFn: () => api<Todo[]>('/api/todos'),
    getKey: (todo) => todo.id,
    onInsert: async ({ transaction }) => {
      const todo = transaction.mutations[0].modified;
      await api('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ id: todo.id, title: todo.title }),
      });
    },
    onUpdate: async ({ transaction }) => {
      const { original, changes } = transaction.mutations[0];
      await api(`/api/todos/${original.id}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
    },
    onDelete: async ({ transaction }) => {
      const { original } = transaction.mutations[0];
      await api(`/api/todos/${original.id}`, { method: 'DELETE' });
    },
  }),
);
