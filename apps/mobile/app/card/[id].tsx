import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { artifactBaseName, formatCost, isFinished, isRunActive, kindExt, statusTone, statusWords } from '../../src/board-model';
import { useCard, usePipeline, useProfiles } from '../../src/card-data';
import { Conversation } from '../../src/conversation';
import { useSession } from '../../src/session';
import { fonts, radius, usePalette } from '../../src/theme';
import { Button, Chip, Divider, Dot, Empty, ErrorMessage, Loading, Panel, T } from '../../src/ui';

type Tab = 'overview' | 'chat' | 'artifacts';

export default function CardDrawer() {
  const { id, tab: initialTab } = useLocalSearchParams<{ id: string; tab?: Tab }>();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const card = useCard(id);
  const pipeline = usePipeline(card.data?.card.projectId);
  const profiles = useProfiles();
  const [tab, setTab] = useState<Tab>(initialTab ?? 'overview');

  const feature = card.data?.card;
  const stages = pipeline.data?.stages ?? [];
  const stage = stages.find(s => s.id === feature?.currentStageId);
  const finished = feature ? isFinished(feature) : false;
  const latestRun = feature ? [...feature.runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0] : undefined;
  const runActive = isRunActive(latestRun?.status);
  const stageAgent = profiles.data?.find(profile => profile.id === stage?.defaultAgentProfileId);
  const shownAgent = runActive ? profiles.data?.find(profile => profile.id === latestRun?.agentProfileId) ?? stageAgent : stageAgent;

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.panel }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={{ paddingHorizontal: 16, paddingTop: 18, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T variant="dim">Feature</T>
        {feature && <Chip tone={statusTone(feature.status)}>{statusWords(feature.status)}</Chip>}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={() => router.back()}>
          <T style={{ color: p.textDim, fontSize: 22, lineHeight: 24 }}>✕</T>
        </Pressable>
      </View>
      {feature && <>
        <T selectable variant="title">{feature.title}</T>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <T variant="label">{finished ? 'Finished' : stage?.name ?? 'Backlog'}</T>
            <T style={{ color: p.textFaint, fontFamily: fonts.mono, fontSize: 11 }}>
              {stage && !finished ? `Stage ${stages.indexOf(stage) + 1} of ${stages.length}` : finished ? 'End of pipeline' : 'Before the first stage'}
            </T>
          </View>
          <View accessibilityLabel="Pipeline position" style={{ flexDirection: 'row', gap: 6 }}>
            {[{ id: 'backlog' }, ...stages, { id: 'completed' }].map(step => {
              const current = finished ? step.id === 'completed' : step.id === (feature.currentStageId ?? 'backlog');
              return <View key={step.id} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: current ? p.brand : p.lineBright }} />;
            })}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T variant="dim" numberOfLines={1} style={{ flexShrink: 1 }}>{shownAgent?.name ?? (finished ? 'Work finished' : stage ? 'No agent assigned' : 'Assign agents in Pipeline')}</T>
            {stage && !finished && <T variant="dim">{stage.gateType === 'manual' ? 'Manual approval' : 'Automatic advancement'}</T>}
          </View>
        </View>
      </>}
    </View>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 22, paddingHorizontal: 16, marginTop: 14, borderBottomWidth: 1, borderBottomColor: p.line }}>
      {(['overview', 'chat', 'artifacts'] as const).map(value => <Pressable
        key={value}
        accessibilityRole="tab"
        accessibilityState={{ selected: tab === value }}
        onPress={() => setTab(value)}
        style={{ paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: tab === value ? p.brand : 'transparent', flexDirection: 'row', alignItems: 'center', gap: 6 }}
      >
        <T style={{ color: tab === value ? p.text : p.textDim, fontFamily: fonts.medium, fontSize: 16 }}>{value === 'overview' ? 'Overview' : value === 'chat' ? 'Chat' : 'Artifacts'}</T>
        {value === 'chat' && runActive && <Dot tone="running" size={6} />}
      </Pressable>)}
    </View>
    <View style={{ flex: 1, paddingBottom: tab === 'chat' ? insets.bottom : 0 }}>
      {card.isPending ? <Loading />
        : card.error ? <View style={{ padding: 16 }}><ErrorMessage error="Could not load this card's details. Check the connection and reopen the card." /></View>
        : tab === 'overview' ? <Overview id={id} onChat={() => setTab('chat')} />
        : tab === 'chat' ? <Conversation featureId={id} />
        : <CardArtifacts id={id} />}
    </View>
  </KeyboardAvoidingView>;
}

function Overview({ id, onChat }: { id: string; onChat: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { client } = useSession();
  const queryClient = useQueryClient();
  const card = useCard(id);
  const pipeline = usePipeline(card.data?.card.projectId);
  const profiles = useProfiles();
  const [more, setMore] = useState(false);
  const feature = card.data!.card;
  const stages = pipeline.data?.stages ?? [];
  const stage = stages.find(s => s.id === feature.currentStageId);
  const finished = isFinished(feature);
  const runs = [...feature.runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  const latestRun = runs[0];
  const runActive = isRunActive(latestRun?.status);
  const stageAgent = profiles.data?.find(profile => profile.id === stage?.defaultAgentProfileId);
  const spend = runs.reduce<number | null>((sum, run) => run.costUsd === null ? sum : (sum ?? 0) + Number(run.costUsd), null);

  const act = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSettled: () => {
      void card.refetch();
      void queryClient.invalidateQueries({ queryKey: ['board', feature.projectId] });
    },
  });
  const reject = () => Alert.prompt('Reject this card', 'It goes back a stage, to the backlog from the first, so the work can be redone. Reason (optional):', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reject', style: 'destructive', onPress: (reason?: string) => act.mutate(() => client.rejectFeature(feature.id, reason?.trim() || undefined)) },
  ], 'plain-text');
  const openPr = (url: string) => { if (/^https:\/\//i.test(url)) void Linking.openURL(url); };

  return <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 20 }}>
    <Panel>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <T variant="label">Next step</T>
        <T variant="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{finished ? 'Reopen to continue' : runActive ? 'Agent at work' : stage ? `Next: ${stages[stages.indexOf(stage) + 1]?.name ?? 'Completed'}` : 'Begin implementation'}</T>
      </View>
      {runActive && <Pressable accessibilityRole="button" onPress={onChat}><T style={{ color: p.brand, fontFamily: fonts.medium }}>Follow the agent's progress →</T></Pressable>}
      {finished && <T variant="dim">This card is finished. Reopen it to change something; it comes back to where it left off.</T>}
      {finished ? <Button title="Reopen" disabled={act.isPending} onPress={() => act.mutate(() => client.moveFeatureBack(feature.id))} />
        : feature.currentStageId ? <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button kind="primary" style={{ flex: 1 }} title="Approve and advance" disabled={act.isPending || runActive} onPress={() => act.mutate(() => client.approveFeature(feature.id))} />
            <Button title="Reject" disabled={act.isPending} onPress={reject} />
          </View>
        : <Button kind="primary" title="Start pipeline" disabled={act.isPending} onPress={() => act.mutate(() => client.advanceFeature(feature.id))} />}
      {feature.pullRequests.map(pr => <Button key={pr.url} title={`Open PR #${pr.number}`} onPress={() => openPr(pr.url)} />)}
      <ErrorMessage error={act.error} />
      {latestRun?.status === 'failed' && latestRun.error && !finished && <ErrorMessage error={latestRun.error} />}
      {formatCost(spend) && <T variant="dim">{formatCost(spend)}</T>}
      <Divider />
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(on => !on)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={{ color: p.textDim, fontSize: 11 }}>{more ? '▼' : '▶'}</T>
        <T variant="dim">More actions</T>
      </Pressable>
      {more && <View style={{ gap: 10 }}>
        {!finished && feature.currentStageId && stage?.gateType !== 'manual' && <Button title="Re-check requirements" disabled={act.isPending} onPress={() => act.mutate(() => client.recheckGate(feature.id))} />}
        {!finished && feature.currentStageId && <Button title="Send back a stage" disabled={act.isPending} onPress={() => act.mutate(() => client.moveFeatureBack(feature.id))} />}
        {!finished && <Button title="Mark completed" disabled={act.isPending} onPress={() => act.mutate(() => client.finishFeature(feature.id))} />}
        {stageAgent && feature.currentStageId && !finished && <Button title={`Run ${stageAgent.name}`} disabled={act.isPending || runActive} onPress={() => act.mutate(() => client.startRun({ featureId: feature.id, agentProfileId: stageAgent.id }))} />}
      </View>}
    </Panel>
    {feature.description.trim() ? <View style={{ gap: 8 }}>
      <T variant="heading">Description</T>
      <T selectable variant="dim" style={{ fontSize: 15, lineHeight: 22 }}>{feature.description}</T>
    </View> : null}
  </ScrollView>;
}

function CardArtifacts({ id }: { id: string }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { client } = useSession();
  const artifacts = useQuery({ queryKey: ['card-artifacts', id], queryFn: () => client.listArtifacts(id) });
  if (artifacts.isPending) return <Loading />;
  if (artifacts.error) return <View style={{ padding: 16 }}><ErrorMessage error={artifacts.error} /></View>;
  if (artifacts.data.length === 0) return <Empty title="No artifacts on this card" body="When an agent produces a write up, mockup, or screenshot here, it will show up." />;
  return <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}>
    {artifacts.data.map(artifact => <Pressable
      key={artifact.id}
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/artifacts/[id]', params: { id, artifact: artifact.id } })}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderColor: p.line, borderRadius: radius + 3, backgroundColor: pressed ? p.panelRaised : p.bg })}
    >
      <Chip>{kindExt(artifact.kind, artifact.path)}</Chip>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="label" numberOfLines={1}>{artifactBaseName(artifact.path)}</T>
        <T variant="faint" numberOfLines={1}>{artifact.stageName}</T>
      </View>
      <T variant="faint">›</T>
    </Pressable>)}
  </ScrollView>;
}
