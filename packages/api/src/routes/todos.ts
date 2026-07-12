import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db, todos } from '@app/db';
import type { AppEnv } from '../auth';
import { authMiddleware } from '../middleware/auth';
import { toTodo } from '../mappers';

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
  const body = await c.req.json<{ title?: string }>();
  const title = (body.title ?? '').trim();
  if (!title) {
    return c.json({ error: 'title is required' }, 400);
  }
  const [row] = await db.insert(todos).values({ userId: user.id, title }).returning();
  return c.json(toTodo(row!), 201);
});

todoRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; completed?: boolean }>();

  const patch: Partial<{ title: string; completed: boolean }> = {};
  if (typeof body.title === 'string') patch.title = body.title.trim();
  if (typeof body.completed === 'boolean') patch.completed = body.completed;

  const [row] = await db
    .update(todos)
    .set(patch)
    .where(and(eq(todos.id, id), eq(todos.userId, user.id)))
    .returning();
  if (!row) {
    return c.json({ error: 'Todo not found' }, 404);
  }
  return c.json(toTodo(row));
});

todoRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [row] = await db
    .delete(todos)
    .where(and(eq(todos.id, id), eq(todos.userId, user.id)))
    .returning();
  if (!row) {
    return c.json({ error: 'Todo not found' }, 404);
  }
  return c.json({ ok: true });
});
