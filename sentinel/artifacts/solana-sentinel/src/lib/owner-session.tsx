import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useGetOwnerSession, useUnlockOwner, useLockOwner, getGetOwnerSessionQueryKey, type OwnerSession } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const Context = createContext<{
  session?: OwnerSession; loading: boolean; error: unknown;
  unlock: (password: string) => Promise<void>; lock: () => Promise<void>;
} | null>(null);
export function OwnerSessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useGetOwnerSession({ query: { retry: false, refetchInterval: 15000, refetchOnWindowFocus: true } });
  const unlock = useUnlockOwner({ mutation: { gcTime: 0 } });
  const lock = useLockOwner();
  useEffect(() => {
    const onError = (error: unknown) => {
      if ((error as { status?: number })?.status !== 401) return;
      const key = getGetOwnerSessionQueryKey();
      const current = qc.getQueryData<OwnerSession>(key);
      if (!current?.authenticated) return;
      qc.setQueryData(key, { ...current, authenticated: false });
      void qc.cancelQueries({ predicate: query => query.queryKey[0] !== key[0] });
      qc.removeQueries({ predicate: query => query.queryKey[0] !== key[0] });
    };
    const unsubscribe = qc.getQueryCache().subscribe(e => {
      if (e.type === 'updated' && e.action.type === 'error') onError(e.query.state.error);
    });
    const unsubscribeMutations = qc.getMutationCache().subscribe(e => {
      if (e.type === 'updated' && e.action.type === 'error') onError(e.mutation.state.error);
    });
    return () => { unsubscribe(); unsubscribeMutations(); };
  }, [qc]);
  // A remotely revoked/expired session must also remove previously loaded data.
  useEffect(() => {
    if (q.data && !q.data.authenticated) {
      const key = getGetOwnerSessionQueryKey();
      qc.removeQueries({ predicate: query => query.queryKey[0] !== key[0] });
    }
  }, [q.data?.authenticated, qc]);
  return <Context.Provider value={{
    session: q.data, loading: q.isLoading, error: q.error,
    unlock: async password => {
      try { await unlock.mutateAsync({ data: { password } }); }
      finally { unlock.reset(); }
      qc.clear();
      window.location.replace(`${base}/dashboard`);
    },
    lock: async () => {
      await lock.mutateAsync();
      qc.clear();
      window.location.replace(`${base}/`);
    },
  }}>{children}</Context.Provider>;
}
export function useOwnerSession() {
  const value = useContext(Context);
  if (!value) throw new Error('Owner session provider missing.');
  return value;
}
