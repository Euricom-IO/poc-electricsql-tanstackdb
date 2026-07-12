import { QueryClient } from '@tanstack/react-query';

// Single shared query client used both by React Query and the TanStack DB
// query collections so invalidations propagate to live queries.
export const queryClient = new QueryClient();
