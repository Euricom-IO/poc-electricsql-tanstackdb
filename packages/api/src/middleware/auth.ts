import { createMiddleware } from 'hono/factory';
import { verifyToken, type AppEnv } from '../auth';

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const payload = await verifyToken(header.slice(7));
    c.set('user', { id: payload.sub, name: payload.name, role: payload.role });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
  await next();
});

export const adminOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user').role !== 'admin') {
    return c.json({ error: 'Forbidden: admin only' }, 403);
  }
  await next();
});
