import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetDashboard, getGetDashboardQueryKey,
  useGetCandidates, getGetCandidatesQueryKey,
  useGetPositions, getGetPositionsQueryKey,
  useGetActivity, getGetActivityQueryKey,
  useGetSettings, getGetSettingsQueryKey,
  useGetConnections, getGetConnectionsQueryKey,
  useGetSetup, getGetSetupQueryKey,
} from '@workspace/api-client-react';

const POLL = 10000;
export const useDash = () => useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), refetchInterval: POLL } });
export const useCands = () => useGetCandidates({ query: { queryKey: getGetCandidatesQueryKey(), refetchInterval: POLL } });
export const usePositionsQ = () => useGetPositions({ query: { queryKey: getGetPositionsQueryKey(), refetchInterval: POLL } });
export const useActivityQ = () => useGetActivity({ query: { queryKey: getGetActivityQueryKey(), refetchInterval: POLL } });
export const useSettingsQ = () => useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
export const useConnectionsQ = () => useGetConnections({ query: { queryKey: getGetConnectionsQueryKey(), refetchInterval: 30000 } });
export const useSetupQ = () => useGetSetup({ query: { queryKey: getGetSetupQueryKey(), refetchInterval: 30000 } });

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [
        getGetDashboardQueryKey(), getGetCandidatesQueryKey(), getGetPositionsQueryKey(),
        getGetActivityQueryKey(), getGetSettingsQueryKey(), getGetConnectionsQueryKey(), getGetSetupQueryKey(),
      ].map((queryKey) => qc.invalidateQueries({ queryKey })),
    );
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
