import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

// A 4xx (not found, forbidden, banned) will not change on a retry: show it straight away. Network and 5xx errors retry once.
export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000,
  retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status >= 400 && e.status < 500) } } });
