import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpacekitAdapter } from "./adapter";
import { CrmStore } from "./store";
import type { Activity, Contact, Deal } from "./types";

export interface CrmState {
  store: CrmStore;
  contacts: Contact[];
  deals: Deal[];
  activity: Activity[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  clearError: () => void;
}

/**
 * useCrm — loads everything through the adapter, then keeps state live:
 * any mutation made through `store` (here or on another device) lands as
 * a sync message and triggers a targeted refresh.
 */
export function useCrm(sk: SpacekitAdapter, actor?: string): CrmState {
  const store = useMemo(() => new CrmStore(sk, { actor }), [sk, actor]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [c, d, a] = await Promise.all([store.listContacts(), store.listDeals(), store.listActivity()]);
      if (!alive.current) return;
      setContacts(c); setDeals(d); setActivity(a); setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Could not load CRM data. Check your SpaceKit connection.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = store.onRemoteChange(() => { void refresh(); });
    return () => { alive.current = false; off(); };
  }, [store, refresh]);

  return { store, contacts, deals, activity, loading, error, refresh, clearError: () => setError(null) };
}
