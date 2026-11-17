import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { Image, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, usePathname } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useProject } from './project';
import { useSession } from './session';
import { Sheet, SheetItem } from './sheet';
import { fonts, radius, usePalette } from './theme';
import { ErrorMessage, Loading, T, UpDownMark } from './ui';

const SECTIONS = [
  { path: '/board', label: 'Board' },
  { path: '/artifacts', label: 'Artifacts' },
  { path: '/sessions', label: 'Sessions' },
] as const;

/** The console's top bar: the Bento mark, the project picker, and a row for the page's own controls. */
export function Shell({ children, toolbar }: PropsWithChildren<{ toolbar?: ReactNode }>) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { project, projects, loading, error } = useProject();
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState(false);
  return <View style={{ flex: 1, backgroundColor: p.bg }}>
    <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 10, gap: 12, borderBottomWidth: 1, borderBottomColor: p.line, backgroundColor: p.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Image source={require('../assets/logo.png')} style={{ width: 26, height: 26, borderRadius: 6 }} accessibilityIgnoresInvertColors />
        <T style={{ color: p.text, fontFamily: fonts.semibold, fontSize: 18 }}>Bento</T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={project ? `Project ${project.name}. Choose another project.` : 'Choose a project'}
          onPress={() => setPicking(true)}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, opacity: pressed ? 0.7 : 1, paddingVertical: 4 })}
        >
          <T numberOfLines={1} style={{ color: p.text, fontFamily: fonts.semibold, fontSize: 18, flexShrink: 1 }}>{project?.name ?? (loading ? '' : 'No project')}</T>
          <UpDownMark />
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Menu" onPress={() => setMenu(true)} hitSlop={6} style={({ pressed }) => ({ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', gap: 4, opacity: pressed ? 0.6 : 1 })}>
          {[0, 1, 2].map(i => <View key={i} style={{ width: 18, height: 2, borderRadius: 1, backgroundColor: p.textDim }} />)}
        </Pressable>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>{toolbar}</View>
      </View>
    </View>
    {error ? <View style={{ padding: 16 }}><ErrorMessage error={error} /></View>
      : loading ? <Loading />
      : !project ? <NoProjects />
      : children}
    <MenuSheet visible={menu} onClose={() => setMenu(false)} />
    <ProjectSheet visible={picking} onClose={() => setPicking(false)} projects={projects ?? []} />
  </View>;
}

function NoProjects() {
  return <View style={{ padding: 24, gap: 8 }}>
    <T variant="heading">No projects yet</T>
    <T variant="dim">Create a project and connect a repository in Bento on the web. Your projects will appear here.</T>
  </View>;
}

function MenuSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { disconnect } = useSession();
  const signOut = useMutation({ mutationFn: disconnect });
  return <Sheet visible={visible} onClose={onClose}>
    {SECTIONS.map(section => <SheetItem
      key={section.path}
      label={section.label}
      selected={pathname === section.path || pathname.startsWith(`${section.path}/`)}
      onPress={() => { onClose(); if (pathname !== section.path) router.replace(section.path); }}
    />)}
    <View style={{ height: 8 }} />
    <SheetItem label={signOut.isPending ? 'Signing out...' : 'Sign out'} destructive onPress={() => signOut.mutate()} />
  </Sheet>;
}

function ProjectSheet({ visible, onClose, projects }: { visible: boolean; onClose: () => void; projects: { id: string; name: string }[] }) {
  const p = usePalette();
  const { client, switchTeam } = useSession();
  const { project, choose } = useProject();
  const account = useQuery({ queryKey: ['account'], queryFn: () => client.getAccountSession(), enabled: visible });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => client.listOrganizations(), enabled: visible });
  const team = useMutation({ mutationFn: switchTeam, onSuccess: onClose });
  const activeTeam = account.data?.session.activeOrganizationId;
  return <Sheet visible={visible} onClose={onClose} title="Projects">
    {projects.map(item => <SheetItem key={item.id} label={item.name} selected={item.id === project?.id} onPress={() => { choose(item.id); onClose(); }} />)}
    {(teams.data?.length ?? 0) > 1 && <>
      <View style={{ height: 1, backgroundColor: p.line, marginVertical: 8, marginHorizontal: 20 }} />
      <T variant="faint" style={{ paddingHorizontal: 20, paddingVertical: 4 }}>Teams</T>
      {teams.data?.map(item => <SheetItem key={item.id} label={item.name} selected={item.id === activeTeam} onPress={() => { if (item.id !== activeTeam) team.mutate(item.id); }} />)}
    </>}
    {team.error ? <View style={{ paddingHorizontal: 20 }}><ErrorMessage error={team.error} /></View> : null}
  </Sheet>;
}

/** The orange "New card" style action in a toolbar. */
export function ToolbarButton({ title, onPress }: { title: string; onPress: () => void }) {
  const p = usePalette();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ backgroundColor: p.brand, borderRadius: radius + 1, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
    <T style={{ color: p.onBrand, fontFamily: fonts.semibold, fontSize: 15 }}>{title}</T>
  </Pressable>;
}
