import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { auth } from './lib/auth';
import { initSyncEngine } from './lib/syncEngine';
import './styles.css';

// Drain any writes queued in a previous (offline) session and start listening
// for connectivity changes.
initSyncEngine();

const router = createRouter({
  routeTree,
  context: { auth },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root')!;
createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
