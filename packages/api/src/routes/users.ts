import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { db, users } from '@app/db';
import type { Role } from '@app/db/types';
import type { AppEnv } from '../auth';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { toUser } from '../mappers';
import { getTxid } from '../txid';

export const userRoutes = new Hono<AppEnv>();

// Only authenticated admins may manage users.
userRoutes.use('*', authMiddleware, adminOnly);

userRoutes.get('/', async (c) => {
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  return c.json(rows.map(toUser));
});

userRoutes.post('/', async (c) => {
  const body = await c.req.json<{ id?: string; name?: string; pin?: string; role?: Role }>();
  const name = (body.name ?? '').trim();
  const pin = String(body.pin ?? '');
  const role: Role = body.role === 'admin' ? 'admin' : 'user';
  if (!name || !pin) {
    return c.json({ error: 'name and pin are required' }, 400);
  }
  const pinHash = await Bun.password.hash(pin);
  try {
    const { row, txid } = await db.transaction(async (tx) => {
      const txid = await getTxid(tx);
      const [row] = await tx
        .insert(users)
        .values({ name, pinHash, role, ...(body.id ? { id: body.id } : {}) })
        .returning();
      return { row: row!, txid };
    });
    return c.json({ ...toUser(row), txid }, 201);
  } catch {
    return c.json({ error: 'A user with that name already exists' }, 409);
  }
});

userRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; pin?: string; role?: Role }>();

  const patch: Partial<{ name: string; role: Role; pinHash: string }> = {};
  if (typeof body.name === 'string') patch.name = body.name.trim();
  if (body.role === 'admin' || body.role === 'user') patch.role = body.role;
  if (typeof body.pin === 'string' && body.pin) patch.pinHash = await Bun.password.hash(body.pin);

  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const [row] = await tx.update(users).set(patch).where(eq(users.id, id)).returning();
    return { row, txid };
  });
  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }
  return c.json({ ...toUser(row), txid });
});

userRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (id === c.get('user').id) {
    return c.json({ error: 'You cannot delete your own account' }, 400);
  }
  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const [row] = await tx.delete(users).where(eq(users.id, id)).returning();
    return { row, txid };
  });
  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }
  return c.json({ ok: true, txid });
});
