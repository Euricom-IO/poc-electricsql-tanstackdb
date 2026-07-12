import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { auth } from '@/lib/auth';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const navigate = useNavigate();
  const user = auth.user;

  function logout() {
    auth.clear();
    void navigate({ to: '/login' });
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <nav className="flex items-center gap-1">
            <Link
              to="/todos"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent [&.active]:bg-accent [&.active]:text-foreground"
            >
              Todos
            </Link>
            {auth.isAdmin && (
              <Link
                to="/admin"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent [&.active]:bg-accent [&.active]:text-foreground"
              >
                Admin
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {user?.name}
              {auth.isAdmin && ' (admin)'}
            </span>
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut className="size-4" /> Logout
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
