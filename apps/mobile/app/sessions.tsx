import { useEffect } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { initials, runTime, runTone, runWords } from '../src/board-model';
import { useProfiles } from '../src/card-data';
import { useProject } from '../src/project';
import { useForeground, useSession } from '../src/session';
import { Shell, ToolbarButton } from '../src/shell';
import { fonts, radius, radiusLg, usePalette } from '../src/theme';
import { Dot, Empty, ErrorMessage, Loading, T } from '../src/ui';

export default function Sessions() {
  return <Shell toolbar={<><View style={{ flex: 1 }} /><ToolbarButton title="New" onPress={() => router.push('/new-session')} /></>}>
    <SessionList />
  </Shell>;
}

function SessionList() {
  const p = usePalette();
  const { client } = useSession();
  const { project } = useProject();
  const projectId = project!.id;
  const active = useForeground();
  const profiles = useProfiles();
  const sessions = useQuery({ queryKey: ['sessions', projectId], queryFn: () => client.listSessions(projectId) });
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void sessions.refetch(); }, 500); };
    const stop = client.streamBoard(projectId, refresh, refresh);
    return () => { stop(); clearTimeout(timer); };
  }, [client, projectId, active]);

  if (sessions.isPending) return <Loading />;
  if (sessions.error) return <View style={{ padding: 16 }}><ErrorMessage error={sessions.error} /></View>;
  const list = sessions.data.sessions;
  return <FlatList
    data={list}
    keyExtractor={session => session.featureId}
    refreshControl={<RefreshControl refreshing={sessions.isRefetching} onRefresh={() => void sessions.refetch()} tintColor={p.textDim} />}
    contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
    ListHeaderComponent={<View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 18, marginTop: 4 }}>
      <View style={{ gap: 4, flexShrink: 1 }}>
        <T variant="title">Sessions</T>
        <T variant="dim">Conversations behind the work.</T>
      </View>
      <T variant="dim">{list.length} conversations</T>
    </View>}
    ListEmptyComponent={<Empty title="No conversations yet" body="Start an agent from New, or from a card on the board." />}
    renderItem={({ item: session, index }) => {
      const run = session.latestRun;
      const agent = run.agentName ?? profiles.data?.find(profile => profile.id === run.agentProfileId)?.name ?? 'agent';
      const first = index === 0;
      const last = index === list.length - 1;
      return <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${session.title}. ${agent} ${runWords(run.status)}.`}
        onPress={() => router.push({ pathname: '/session/[id]', params: { id: session.featureId } })}
        style={({ pressed }) => ({
          flexDirection: 'row', gap: 14, padding: 14,
          backgroundColor: pressed ? p.panelRaised : p.panel,
          borderColor: p.line, borderLeftWidth: 1, borderRightWidth: 1, borderTopWidth: 1, borderBottomWidth: last ? 1 : 0,
          borderTopLeftRadius: first ? radiusLg + 2 : 0, borderTopRightRadius: first ? radiusLg + 2 : 0,
          borderBottomLeftRadius: last ? radiusLg + 2 : 0, borderBottomRightRadius: last ? radiusLg + 2 : 0,
        })}
      >
        <View style={{ width: 30, height: 30, borderRadius: radius + 1, borderWidth: 1, borderColor: p.lineBright, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
          <T style={{ color: p.text, fontFamily: fonts.semibold, fontSize: 11 }}>{initials(agent)}</T>
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <T variant="label" numberOfLines={2} style={{ fontSize: 15 }}>{session.title}</T>
          <T variant="faint">{runTime(run.queuedAt)}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Dot tone={runTone(run.status)} size={6} />
            <T variant="dim" numberOfLines={1} style={{ flexShrink: 1 }}>{agent} {runWords(run.status)}</T>
            <T variant="faint">{session.runCount === 1 ? '1 run' : `${session.runCount} runs`}{session.totalCostUsd !== null ? ` · $${session.totalCostUsd.toFixed(2)}` : ''}</T>
          </View>
        </View>
      </Pressable>;
    }}
  />;
}
