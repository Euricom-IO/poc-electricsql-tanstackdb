// Pure DTO types shared across the API and the web client.
// No runtime dependencies here so the browser bundle stays free of drizzle/postgres.

export type Role = 'user' | 'admin';

export interface User {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface Todo {
  id: string;
  userId: string;
  title: string;
  completed: boolean;
  createdAt: string;
}
