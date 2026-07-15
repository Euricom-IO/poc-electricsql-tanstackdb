import { Hono } from 'hono';
import { signPowerSyncToken, type AppEnv } from '../auth';
import { authMiddleware } from '../middleware/auth';

/**
 * PowerSync auth endpoint.
 *
 * The `web-powersync` client's `fetchCredentials` (see the ApiConnector in
 * packages/web-powersync/src/lib/powersync.ts) calls this with the user's
 * session token and feeds the response straight into the sync connector. We
 * return a short-lived, PowerSync-shaped token minted for that user plus the
 * service endpoint to stream from.
 */

// The publicly reachable PowerSync service URL handed to the browser client.
const POWERSYNC_URL = process.env.POWERSYNC_URL ?? 'http://localhost:8080';

export const powersyncRoutes = new Hono<AppEnv>();

powersyncRoutes.use('*', authMiddleware);

powersyncRoutes.get('/token', async (c) => {
  const user = c.get('user');
  const token = await signPowerSyncToken(user.id);
  console.log('[powersync] issued token for user', user.id, 'endpoint', POWERSYNC_URL);
  return c.json({ token, endpoint: POWERSYNC_URL });
});
