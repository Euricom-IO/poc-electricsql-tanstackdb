import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db, todos } from '@app/db';
import type { AppEnv } from '../auth';
import { authMiddleware } from '../middleware/auth';
import { toTodo } from '../mappers';
import { getTxid } from '../txid';

export const todoRoutes = new Hono<AppEnv>();

todoRoutes.use('*', authMiddleware);

todoRoutes.get('/', async (c) => {
  const user = c.get('user');
  const rows = await db
    .select()
    .from(todos)
    .where(eq(todos.userId, user.id))
    .orderBy(desc(todos.createdAt));
  return c.json(rows.map(toTodo));
});

todoRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ id?: string; title?: string }>();
  const title = (body.title ?? '').trim();
  if (!title) {
    return c.json({ error: 'title is required' }, 400);
  }
  // Wrap the write in a transaction so we can hand back its txid for Electric
  // sync matching. A client-supplied id is honored (like the users route) so
  // optimistic Electric inserts keep a stable key.
  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const [row] = await tx
      .insert(todos)
      .values({ userId: user.id, title, ...(body.id ? { id: body.id } : {}) })
      .returning();
    return { row: row!, txid };
  });
  return c.json({ ...toTodo(row), txid }, 201);
});

todoRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; completed?: boolean }>();

  const patch: Partial<{ title: string; completed: boolean }> = {};
  if (typeof body.title === 'string') patch.title = body.title.trim();
  if (typeof body.completed === 'boolean') patch.completed = body.completed;

  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const [row] = await tx
      .update(todos)
      .set(patch)
      .where(and(eq(todos.id, id), eq(todos.userId, user.id)))
      .returning();
    return { row, txid };
  });
  if (!row) {
    return c.json({ error: 'Todo not found' }, 404);
  }
  return c.json({ ...toTodo(row), txid });
});

todoRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const [row] = await tx
      .delete(todos)
      .where(and(eq(todos.id, id), eq(todos.userId, user.id)))
      .returning();
    return { row, txid };
  });
  if (!row) {
    return c.json({ error: 'Todo not found' }, 404);
  }
  return c.json({ ok: true, txid });
});
