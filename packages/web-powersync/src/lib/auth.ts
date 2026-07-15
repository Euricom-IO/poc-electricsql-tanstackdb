import type { User } from '@app/db/types';

const TOKEN_KEY = 'auth.token';
const USER_KEY = 'auth.user';

/**
 * Tiny auth store backed by localStorage. Kept intentionally simple for the
 * POC: the JWT and the current user are persisted and read synchronously.
 */
export const auth = {
  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  get user(): User | null {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  },
  get isAuthenticated(): boolean {
    return this.token !== null;
  },
  get isAdmin(): boolean {
    return this.user?.role === 'admin';
  },
  set(token: string, user: User): void {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export interface RouterContext {
  auth: typeof auth;
}
