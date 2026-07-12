import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, users } from '@app/db';
import { signToken, type AppEnv } from '../auth';
import { authMiddleware } from '../middleware/auth';
import { toUser } from '../mappers';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/login', async (c) => {
  const { name, pin } = await c.req.json<{ name?: string; pin?: string }>();
  if (!name || !pin) {
    return c.json({ error: 'name and pin are required' }, 400);
  }

  const [user] = await db.select().from(users).where(eq(users.name, name));
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const ok = await Bun.password.verify(pin, user.pinHash);
  if (!ok) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await signToken({ id: user.id, name: user.name, role: user.role });
  return c.json({ token, user: toUser(user) });
});

authRoutes.get('/me', authMiddleware, (c) => c.json(c.get('user')));
