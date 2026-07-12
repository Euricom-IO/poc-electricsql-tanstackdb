import { createCollection } from '@tanstack/react-db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import type { Role } from '@app/db/types';
import { api } from '@/lib/api';
import { ELECTRIC_URL } from '@/lib/electric';

/**
 * A user row as it arrives from the ElectricSQL shape stream. The shape selects
 * only these columns — `pin_hash` is deliberately excluded so password hashes
 * never reach the browser.
 */
export type UserRow = {
  id: string;
  name: string;
  role: Role;
  created_at: string;
};

/**
 * Local collection item: a `UserRow` plus a write-only `pin`. The pin is needed
 * when creating a user or resetting a credential, but is never synced back, so
 * it is simply `undefined` again once the real row streams in from Electric.
 */
export type UserItem = UserRow & {
  pin?: string;
};

/**
 * Users as an optimistic TanStack DB collection backed by ElectricSQL (admin
 * page). Reads stream live from the Electric shape API; writes go through the
 * existing API, which returns the Postgres `txid` for sync matching.
 */
export const userCollection = createCollection(
  electricCollectionOptions<UserItem>({
    id: 'users',
    shapeOptions: {
      url: ELECTRIC_URL,
      // Exclude pin_hash — never sync credential hashes to the client.
      params: { table: 'users', columns: ['id', 'name', 'role', 'created_at'] },
    },
    getKey: (user) => user.id,
    onInsert: async ({ transaction }) => {
      const user = transaction.mutations[0].modified;
      const { txid } = await api<{ txid: number }>('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          id: user.id,
          name: user.name,
          pin: user.pin,
          role: user.role,
        }),
      });
      return { txid };
    },
    onUpdate: async ({ transaction }) => {
      const { original, changes } = transaction.mutations[0];
      const { txid } = await api<{ txid: number }>(`/api/users/${original.id}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      return { txid };
    },
    onDelete: async ({ transaction }) => {
      const { original } = transaction.mutations[0];
      const { txid } = await api<{ txid: number }>(`/api/users/${original.id}`, {
        method: 'DELETE',
      });
      return { txid };
    },
  }),
);
