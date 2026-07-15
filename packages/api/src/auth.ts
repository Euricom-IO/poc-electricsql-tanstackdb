import { sign, verify } from 'hono/jwt';
import type { Role } from '@app/db/types';

export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  name: string;
  role: Role;
  exp: number;
  [key: string]: unknown;
}

// Hono context typing: makes c.get('user') / c.set('user') type-safe.
export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};

export async function signToken(user: AuthUser): Promise<string> {
  const payload: JwtPayload = {
    sub: user.id,
    name: user.name,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  return sign(payload, JWT_SECRET);
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  return (await verify(token, JWT_SECRET, 'HS256')) as JwtPayload;
}

// --- PowerSync sync token -------------------------------------------------
//
// The PowerSync service verifies this token statically (it never calls back to
// the API), so — unlike the long-lived session token above — it must carry the
// exact claims/headers PowerSync requires and live only briefly; the client
// refreshes it automatically. It is signed with the same JWT_SECRET, so
// PowerSync trusts it via one shared HS256 key (see docker-compose.yml).

/** Short lifetime: PowerSync rejects tokens older than 60 min. */
const POWERSYNC_TOKEN_TTL_SECONDS = 60 * 5;
/** Must match the `kid` of the key configured in powersync/config.yaml. */
const POWERSYNC_KID = 'powersync';
/** Must match one of `client_auth.audience` in powersync/config.yaml. */
const POWERSYNC_AUDIENCE = 'powersync';

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a short-lived JWT for the PowerSync sync service for `userId` (used as
 * the `sub`, which sync rules read via `request.user_id()`). `hono/jwt`'s
 * `sign` can't set a `kid` header, which PowerSync requires, so the token is
 * assembled and HMAC-signed directly.
 */
export async function signPowerSyncToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: POWERSYNC_KID };
  const payload = {
    sub: userId,
    aud: POWERSYNC_AUDIENCE,
    iat: now,
    exp: now + POWERSYNC_TOKEN_TTL_SECONDS,
  };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${base64url(signature)}`;
}
