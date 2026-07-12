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
