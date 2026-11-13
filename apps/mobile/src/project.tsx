import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useQuery } from '@tanstack/react-query';
import type { Project } from '@bento/api-client';
import { useSession } from './session';

const key = 'bento.mobile.project';
const saved = {
  get: () => Platform.OS === 'web' ? Promise.resolve(null) : SecureStore.getItemAsync(key),
  set: (id: string) => Platform.OS === 'web' ? Promise.resolve() : SecureStore.setItemAsync(key, id),
};

const Context = createContext<{
  projects: Project[] | undefined;
  project: Project | null;
  loading: boolean;
  error: unknown;
  choose: (id: string) => void;
  refetch: () => void;
} | null>(null);

/** The project the board, sessions and artifacts screens show, remembered across launches. */
export function ProjectProvider({ children }: PropsWithChildren) {
  const { client } = useSession();
  const [chosen, setChosen] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => client.listProjects() });
  useEffect(() => {
    void saved.get().then(id => setChosen(id)).catch(() => {}).finally(() => setRestored(true));
  }, []);
  const list = projects.data;
  const project = list?.find(item => item.id === chosen) ?? list?.[0] ?? null;
  const value = {
    projects: list,
    project,
    loading: !restored || projects.isPending,
    error: projects.error,
    choose: (id: string) => { setChosen(id); void saved.set(id).catch(() => {}); },
    refetch: () => void projects.refetch(),
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProject() {
  const value = useContext(Context);
  if (!value) throw new Error('ProjectProvider is missing.');
  return value;
}
