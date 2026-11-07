import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { BentoClient } from '@bento/api-client';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { serverOrigin } from './model';
import { ErrorMessage, Loading, Screen, Button } from './ui';

type Credentials = { origin: string; token: string };
const key = 'bento.mobile.session';
// The browser preview deliberately keeps credentials only in memory.
const storage = {
  get: () => Platform.OS === 'web' ? Promise.resolve(null) : SecureStore.getItemAsync(key),
  set: (value: string) => Platform.OS === 'web' ? Promise.resolve() : SecureStore.setItemAsync(key, value),
  clear: () => Platform.OS === 'web' ? Promise.resolve() : SecureStore.deleteItemAsync(key),
};
export const mobileFetch = (Platform.OS === 'web' ? globalThis.fetch.bind(globalThis) : expoFetch) as typeof fetch;
const Context = createContext<{
  client: BentoClient; origin: string; authenticated: boolean; generation: number;
  connect: (credentials: Credentials) => Promise<void>;
  disconnect: () => Promise<void>;
  switchTeam: (id: string) => Promise<void>;
} | null>(null);
export function SessionProvider({ children }: PropsWithChildren) {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 }, mutations: { retry: false } } }));
  useEffect(() => {
    void storage.get().then(value => {
      if (value) {
        const saved = JSON.parse(value) as Credentials;
        if (!saved.token || typeof saved.token !== 'string') throw new Error('Saved sign-in is invalid.');
        setCredentials({ origin: serverOrigin(saved.origin), token: saved.token });
      }
    }).catch(setError).finally(() => setReady(true));
    const subscription = AppState.addEventListener('change', state => focusManager.setFocused(state === 'active'));
    return () => subscription.remove();
  }, []);
  const origin = credentials?.origin ?? 'https://app.usebento.ai';
  const client = useMemo(() => {
    let expired = false;
    return new BentoClient({
      baseUrl: origin,
      fetch: async (url, init) => {
        const response = await mobileFetch(url, init);
        if (response.status === 401 && credentials && !expired) {
          expired = true;
          void clear().catch(setError);
        }
        return response;
      },
      tokens: { get: () => credentials?.token ?? null, set: async () => {} },
    });
  }, [credentials, origin]);
  async function clear() {
    await storage.clear();
    await queryClient.cancelQueries();
    queryClient.clear();
    setCredentials(null);
    setGeneration(value => value + 1);
    setError(undefined);
  }
  const value = {
    client, origin, authenticated: Boolean(credentials), generation,
    connect: async (next: Credentials) => {
      const probe = new BentoClient({ baseUrl: next.origin, fetch: mobileFetch, tokens: { get: () => next.token, set: async () => {} } });
      if (!await probe.getAccountSession()) throw new Error('Sign-in expired. Please try again.');
      await storage.set(JSON.stringify(next));
      queryClient.clear();
      setCredentials(next);
      setGeneration(value => value + 1);
    },
    disconnect: async () => { try { await client.signOut(); } finally { await clear(); } },
    switchTeam: async (id: string) => {
      await client.setActiveOrganization(id);
      await queryClient.cancelQueries();
      queryClient.clear();
      setGeneration(value => value + 1);
    },
  };
  if (!ready) return <Screen><Loading /></Screen>;
  if (error) return <Screen><ErrorMessage error={error} /><Button title="Clear saved sign-in" onPress={() => void clear().catch(setError)} /></Screen>;
  return <Context.Provider value={value}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></Context.Provider>;
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error('SessionProvider is missing.');
  return value;
}
export function useForeground() {
  const [active, setActive] = useState(AppState.currentState === 'active' || Platform.OS === 'web');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}
