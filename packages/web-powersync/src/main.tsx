import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { auth } from './lib/auth';
import { initPowerSync } from './lib/powersync';
import './styles.css';

// Open the local PowerSync database and start syncing (drains any writes queued
// in a previous session, then streams changes once a service is configured).
void initPowerSync();

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
