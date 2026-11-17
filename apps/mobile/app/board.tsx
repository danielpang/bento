import { memo, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { AgentProfile, Feature } from '@bento/api-client';
import { boardLanes, cardState, isRunActive, stateLabel, stateTone, type Lane } from '../src/board-model';
import { useProfiles } from '../src/card-data';
import { useProject } from '../src/project';
import { useForeground, useSession } from '../src/session';
import { Shell, ToolbarButton } from '../src/shell';
import { fonts, radius, radiusLg, toneColor, usePalette } from '../src/theme';
import { ErrorMessage, Loading, SearchField, T } from '../src/ui';

const GAP = 10;

export default function Board() {
  const [search, setSearch] = useState('');
  return <Shell toolbar={<>
    <SearchField value={search} onChangeText={setSearch} placeholder="Search cards or ticket id" style={{ flex: 1 }} />
    <ToolbarButton title="New card" onPress={() => router.push('/new-card')} />
  </>}>
    <Lanes search={search} />
  </Shell>;
}

function Lanes({ search }: { search: string }) {
  const p = usePalette();
  const { client } = useSession();
  const { project } = useProject();
  const projectId = project!.id;
  const active = useForeground();
  const { width } = useWindowDimensions();
  const laneWidth = Math.min(380, width - 56);
  const profiles = useProfiles();
  const board = useQuery({
    queryKey: ['board', projectId],
    queryFn: async () => {
      const [cards, pipeline, snapshot] = await Promise.all([client.listFeatures(projectId), client.getPipeline(projectId), client.getBoardSnapshot(projectId)]);
      return { cards, pipeline, snapshot };
    },
  });
  useEffect(() => {
    if (!active) return;
    void board.refetch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void board.refetch(); }, 300); };
    const stop = client.streamBoard(projectId, refresh, refresh);
    return () => { stop(); clearTimeout(timer); };
  }, [client, projectId, active]);

  const lanes = useMemo(() => board.data ? boardLanes(board.data.cards, board.data.pipeline.stages, search) : [], [board.data, search]);
  if (board.isPending) return <Loading />;
  if (board.error) return <View style={{ padding: 16 }}><ErrorMessage error={board.error} /></View>;
  const { statuses, outputs } = board.data.snapshot;
  return <ScrollView
    horizontal
    decelerationRate="fast"
    snapToInterval={laneWidth + GAP}
    snapToAlignment="start"
    showsHorizontalScrollIndicator={false}
    contentContainerStyle={{ padding: 16, gap: GAP }}
    style={{ flex: 1, backgroundColor: p.bg }}
  >
    {lanes.map(lane => <LaneColumn
      key={lane.key}
      lane={lane}
      width={laneWidth}
      searching={Boolean(search.trim())}
      agent={profiles.data?.find(profile => profile.id === lane.stage?.defaultAgentProfileId)}
      statuses={statuses}
      outputs={outputs}
      refreshing={board.isRefetching}
      onRefresh={() => void board.refetch()}
    />)}
  </ScrollView>;
}

function LaneColumn({ lane, width, searching, agent, statuses, outputs, refreshing, onRefresh }: {
  lane: Lane; width: number; searching: boolean; agent: AgentProfile | undefined;
  statuses: Record<string, string>; outputs: Record<string, string>; refreshing: boolean; onRefresh: () => void;
}) {
  const p = usePalette();
  const empty = searching
    ? <T variant="faint" style={{ textAlign: 'center', paddingVertical: 24 }}>No matches</T>
    : lane.key === 'backlog'
      ? <Pressable accessibilityRole="button" onPress={() => router.push('/new-card')} style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: p.lineBright, borderRadius: radius, padding: 12, alignItems: 'center' }}>
          <T variant="dim">Add a card</T>
        </Pressable>
      : lane.key === 'completed' ? <T variant="faint" style={{ textAlign: 'center', paddingVertical: 24 }}>Nothing finished yet</T> : null;
  return <View style={{ width, borderWidth: 1, borderColor: p.line, borderRadius: radiusLg + 4, backgroundColor: p.panel, overflow: 'hidden' }}>
    <View style={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 10, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={{ color: p.brand, fontFamily: fonts.mono, fontSize: 12 }}>{lane.ordinal}</T>
        <T numberOfLines={2} style={{ flex: 1, color: p.text, fontFamily: fonts.semibold, fontSize: 16 }}>{lane.name}</T>
        <T style={{ color: p.textFaint, fontFamily: fonts.mono, fontSize: 12 }}>{lane.cards.length}</T>
      </View>
      <T variant="dim" numberOfLines={1}>{lane.stage ? agent?.name ?? 'no agent assigned' : lane.note}</T>
      {lane.stage && <T variant="faint">{lane.stage.gateType === 'manual' ? 'Review before advancing' : 'Advances automatically'}</T>}
    </View>
    <FlatList
      data={lane.cards}
      keyExtractor={card => card.id}
      contentContainerStyle={{ padding: 10, paddingTop: 4, gap: 10 }}
      ListEmptyComponent={empty}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={p.textDim} />}
      renderItem={({ item }) => <Card feature={item} runStatus={statuses[item.id]} lastOutput={outputs[item.id]} />}
    />
  </View>;
}

const Card = memo(function Card({ feature, runStatus, lastOutput }: { feature: Feature; runStatus: string | undefined; lastOutput: string | undefined }) {
  const p = usePalette();
  const state = cardState(feature, runStatus);
  const tone = toneColor(p, stateTone(state));
  const showLine = lastOutput && (isRunActive(runStatus) || runStatus === 'failed');
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={`${feature.title}, ${stateLabel(state)}`}
    onPress={() => router.push({ pathname: '/card/[id]', params: { id: feature.id } })}
    style={({ pressed }) => ({
      backgroundColor: p.panelRaised,
      borderWidth: 1,
      borderColor: state === 'running' ? p.running : pressed ? p.lineBright : p.line,
      borderRadius: radiusLg,
      paddingVertical: 14,
      paddingRight: 14,
      paddingLeft: 28,
      gap: 12,
    })}
  >
    <View style={{ position: 'absolute', left: 12, top: 17, width: 4, height: 16, borderRadius: 2, backgroundColor: tone }} />
    <T style={{ color: p.text, fontFamily: fonts.semibold, fontSize: 15, lineHeight: 21 }}>{feature.title}</T>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <T variant="small">{stateLabel(state)}</T>
      {feature.prNumber ? <T style={{ color: p.textDim, fontFamily: fonts.mono, fontSize: 11, borderWidth: 1, borderColor: p.lineBright, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>PR #{feature.prNumber}</T> : null}
    </View>
    {showLine ? <T numberOfLines={1} style={{ color: p.textDim, fontFamily: fonts.mono, fontSize: 11.5 }}>{lastOutput}</T> : null}
  </Pressable>;
});

