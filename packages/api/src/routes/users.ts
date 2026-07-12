import { Hono } from 'hono';
import { asc } from 'drizzle-orm';
import { db, users } from '@app/db';
import type { Role } from '@app/db/types';
import type { AppEnv } from '../auth';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { toUser } from '../mappers';
import { getTxid } from '../txid';
import { applyUserInsert, applyUserUpdate, applyUserDelete } from '../services/users';
import { ServiceError } from '../services/errors';

export const userRoutes = new Hono<AppEnv>();

// Only authenticated admins may manage users.
userRoutes.use('*', authMiddleware, adminOnly);

userRoutes.get('/', async (c) => {
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  return c.json(rows.map(toUser));
});

userRoutes.post('/', async (c) => {
  const body = await c.req.json<{ id?: string; name?: string; pin?: string; role?: Role }>();
  try {
    const { row, txid } = await db.transaction(async (tx) => {
      const txid = await getTxid(tx);
      const row = await applyUserInsert(tx, body);
      return { row, txid };
    });
    return c.json({ ...toUser(row), txid }, 201);
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

userRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; pin?: string; role?: Role }>();
  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const row = await applyUserUpdate(tx, { id, ...body });
    return { row, txid };
  });
  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }
  return c.json({ ...toUser(row), txid });
});

userRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');
  try {
    const { row, txid } = await db.transaction(async (tx) => {
      const txid = await getTxid(tx);
      const row = await applyUserDelete(tx, actor, { id });
      return { row, txid };
    });
    if (!row) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true, txid });
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});
