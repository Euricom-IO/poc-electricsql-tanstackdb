import { createCollection } from '@tanstack/react-db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import type { User } from '@app/db/types';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';

/**
 * Local collection item: a `User` plus a write-only `pin`. The pin is needed
 * when creating a user or resetting a credential, but the API never returns it,
 * so it is simply `undefined` again after the collection refetches.
 */
export interface UserItem extends User {
  pin?: string;
}

/**
 * Users as a fully optimistic TanStack DB collection (admin page), mirroring the
 * todos collection: insert/update/delete apply optimistically and are persisted
 * through the mutation handlers below.
 */
export const userCollection = createCollection(
  queryCollectionOptions<UserItem>({
    queryClient,
    queryKey: ['users'],
    queryFn: () => api<User[]>('/api/users'),
    getKey: (user) => user.id,
    onInsert: async ({ transaction }) => {
      const user = transaction.mutations[0].modified;
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          id: user.id,
          name: user.name,
          pin: user.pin,
          role: user.role,
        }),
      });
    },
    onUpdate: async ({ transaction }) => {
      const { original, changes } = transaction.mutations[0];
      await api(`/api/users/${original.id}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
    },
    onDelete: async ({ transaction }) => {
      const { original } = transaction.mutations[0];
      await api(`/api/users/${original.id}`, { method: 'DELETE' });
    },
  }),
);
