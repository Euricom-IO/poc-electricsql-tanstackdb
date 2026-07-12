import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, processedEvents } from '@app/db';
import type { SyncCommand } from '@app/db/types';
import type { AppEnv, AuthUser } from '../auth';
import { authMiddleware } from '../middleware/auth';
import { getTxid } from '../txid';
import { applyTodoInsert, applyTodoUpdate, applyTodoDelete } from '../services/todos';
import { applyUserInsert, applyUserUpdate, applyUserDelete } from '../services/users';
import { ServiceError } from '../services/errors';

// The transaction object passed to db.transaction(async (tx) => ...).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const eventRoutes = new Hono<AppEnv>();

eventRoutes.use('*', authMiddleware);

/**
 * Apply one offline-sync command inside the given transaction. Todo commands
 * are scoped to the actor; user commands require admin. Update/delete that
 * match no row are treated as an already-applied no-op (not a terminal error),
 * so a stale replay after reconnect still succeeds.
 */
async function dispatch(tx: Tx, actor: AuthUser, cmd: SyncCommand): Promise<void> {
  if (cmd.entity === 'todo') {
    switch (cmd.op) {
      case 'insert':
        await applyTodoInsert(tx, actor, cmd.payload);
        return;
      case 'update':
        await applyTodoUpdate(tx, actor, cmd.payload);
        return;
      case 'delete':
        await applyTodoDelete(tx, actor, cmd.payload);
        return;
    }
  }
  if (cmd.entity === 'user') {
    if (actor.role !== 'admin') throw new ServiceError(403, 'Forbidden: admin only');
    switch (cmd.op) {
      case 'insert':
        await applyUserInsert(tx, cmd.payload);
        return;
      case 'update':
        await applyUserUpdate(tx, cmd.payload);
        return;
      case 'delete':
        await applyUserDelete(tx, actor, cmd.payload);
        return;
    }
  }
  throw new ServiceError(400, `Unknown command: ${cmd.entity}.${cmd.op}`);
}

/**
 * Single write path for the offline event store. A command is applied at most
 * once: the client event id is recorded in the processed_events ledger, and a
 * replay short-circuits to return the original txid so Electric reconciliation
 * always completes. Everything runs in one transaction so the row change and
 * its ledger entry commit together.
 */
eventRoutes.post('/', async (c) => {
  const actor = c.get('user');
  const cmd = await c.req.json<SyncCommand>();
  if (!cmd?.id || !cmd.entity || !cmd.op) {
    return c.json({ error: 'invalid command' }, 400);
  }
  try {
    const { txid } = await db.transaction(async (tx) => {
      const [seen] = await tx
        .select()
        .from(processedEvents)
        .where(eq(processedEvents.id, cmd.id));
      if (seen) return { txid: seen.txid };

      const txid = await getTxid(tx);
      await dispatch(tx, actor, cmd);
      await tx.insert(processedEvents).values({
        id: cmd.id,
        entity: cmd.entity,
        op: cmd.op,
        userId: actor.id,
        txid,
      });
      return { txid };
    });
    return c.json({ txid });
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});
