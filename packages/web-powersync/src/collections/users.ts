import { createCollection } from '@tanstack/react-db';
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection';
import { z } from 'zod';
import { db, APP_SCHEMA } from '@/lib/powersync';

/**
 * Users as an optimistic TanStack DB collection backed by PowerSync (admin page,
 * option 3). The local table holds only the safe columns — `pin_hash` is never
 * synced to the client. `created_at` is stored as ISO text and transformed into
 * a `Date` on read.
 *
 * The write-only `pin` needed when creating a user or resetting a credential is
 * NOT a synced column: it is passed as PowerSync operation metadata
 * (`{ metadata: { pin } }`) and read back off the CrudEntry during upload.
 */
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['user', 'admin']),
  created_at: z.string().transform((value) => new Date(value)),
});

/** A user as read from the collection (rich output types). */
export type User = z.output<typeof userSchema>;

export const userCollection = createCollection(
  powerSyncCollectionOptions({
    database: db,
    table: APP_SCHEMA.props.users,
    schema: userSchema,
    onDeserializationError: (error) => {
      console.error('[users] failed to deserialize a synced row', error);
    },
    serializer: {
      created_at: (value) => value.toISOString(),
    },
  }),
);
