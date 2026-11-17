import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentEvent } from '@bento/core';
import type { AgentRun, ConversationBlock } from '@bento/api-client';
import { forgetsBetweenRuns } from '@bento/core';
import { composerHint, composerPlaceholder, formatCost, isFinished, isRunActive, runLiveKind, runTime, runTone, runWords, toChatItems, type ChatItem } from './board-model';
import { useCard, usePipeline, useProfiles } from './card-data';
import { Questions } from './questions';
import { useSession } from './session';
import { Sheet, SheetItem } from './sheet';
import { fonts, radius, radiusLg, usePalette } from './theme';
import { useLiveRun } from './transcript';
import { Dot, ErrorMessage, Loading, T, UpDownMark } from './ui';

/** A card's conversation: one run at a time, newest by default, with a composer. */
export function Conversation({ featureId, label = 'Conversation' }: { featureId: string; label?: string }) {
  const p = usePalette();
  const { client } = useSession();
  const queryClient = useQueryClient();
  const card = useCard(featureId);
  const profiles = useProfiles();
  const pipeline = usePipeline(card.data?.card.projectId);
  const [viewedRunId, setViewedRunId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [message, setMessage] = useState('');
  const scroll = useRef<ScrollView>(null);

  const runs = useMemo(() => [...(card.data?.card.runs ?? [])].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)), [card.data]);
  const latest = runs[0];
  const viewed = runs.find(run => run.id === viewedRunId) ?? latest;
  const following = !viewedRunId || viewedRunId === latest?.id;
  const block = card.data?.conversation.blocks.find(item => item.runId === viewed?.id);
  const liveRunId = viewed && isRunActive(viewed.status) ? viewed.id : null;
  const live = useLiveRun(liveRunId, () => void card.refetch());
  const profileFor = (run: AgentRun | undefined) => profiles.data?.find(profile => profile.id === run?.agentProfileId);
  const agentName = block?.agentName ?? profileFor(viewed)?.name ?? 'Agent';
  const latestAgent = profileFor(latest);
  const runActive = isRunActive(latest?.status);
  const liveKind = latestAgent ? runLiveKind(latestAgent.cli, latest?.liveSession) : undefined;
  const resumes = !latestAgent || !forgetsBetweenRuns(latestAgent.cli);
  const finished = card.data ? isFinished(card.data.card) : false;

  const send = useMutation({
    mutationFn: async () => {
      await client.messageFeature(featureId, message.trim());
      setMessage('');
    },
    onSuccess: () => {
      setViewedRunId(null);
      void card.refetch();
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const caption = (run: AgentRun) => {
    const stage = pipeline.data?.stages.find(s => s.id === run.stageId)?.name;
    return `${stage ?? profileFor(run)?.name ?? 'agent'} · ${runTime(run.queuedAt)}`;
  };

  if (card.isPending) return <Loading />;
  if (card.error) return <View style={{ padding: 16 }}><ErrorMessage error={card.error} /></View>;

  return <View style={{ flex: 1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
      <T variant="label">{label}{viewed && !following ? ` (run from ${runTime(viewed.queuedAt)})` : ''}</T>
      <Pressable accessibilityRole="button" accessibilityState={{ selected: showTools }} onPress={() => setShowTools(on => !on)} hitSlop={8}>
        <T variant="dim" style={{ fontFamily: fonts.medium }}>{showTools ? 'Collapse tools' : 'Expand tools'}</T>
      </Pressable>
    </View>
    {viewed && <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Showing ${caption(viewed)}, ${runWords(viewed.status)}. Choose another run.`}
      onPress={() => setPicking(true)}
      style={{ marginHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: p.fieldLine, borderRadius: radius + 1, paddingHorizontal: 12, minHeight: 44 }}
    >
      <Dot tone={runTone(viewed.status)} />
      <T variant="body" numberOfLines={1} style={{ flex: 1 }}>{caption(viewed)}</T>
      <UpDownMark />
    </Pressable>}
    <Sheet visible={picking} onClose={() => setPicking(false)} title="Runs on this card">
      {runs.map(run => <SheetItem
        key={run.id}
        label={caption(run)}
        detail={runWords(run.status)}
        leading={<Dot tone={runTone(run.status)} />}
        selected={run.id === viewed?.id}
        onPress={() => { setViewedRunId(run.id === latest?.id ? null : run.id); setPicking(false); }}
      />)}
    </Sheet>

    <ScrollView
      ref={scroll}
      style={{ flex: 1, marginTop: 10 }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => { if (following) scroll.current?.scrollToEnd({ animated: false }); }}
    >
      {card.data?.questions.map(request => <Questions key={request.id} request={request} onAnswered={() => void card.refetch()} />)}
      {!viewed && <T variant="dim">No agent has run on this card yet. Start it from the card's Actions, and the conversation appears here.</T>}
      {viewed && <RunSection
        run={viewed}
        agentName={agentName}
        block={block}
        liveEvents={liveRunId ? live.events : null}
        draft={liveRunId ? live.draft : ''}
        showTools={showTools}
      />}
      <ErrorMessage error={live.error} />
      {following && card.data?.conversation.pending.map(pending => <Bubble key={pending.id} role="user" speaker={pending.status === 'queued' ? 'you · queued' : 'you · sent'} text={pending.text} faded />)}
      {following && runActive && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
        <ActivityIndicator size="small" color={p.running} />
        <T variant="dim">{agentName} is working</T>
      </View>}
    </ScrollView>

    {!finished && <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8, borderTopWidth: 1, borderTopColor: p.line, backgroundColor: p.bg }}>
      <ErrorMessage error={send.error} />
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, backgroundColor: p.panel, borderRadius: radiusLg, borderWidth: 1, borderColor: p.line, padding: 6, paddingLeft: 14 }}>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder={composerPlaceholder(runActive, liveKind)}
          accessibilityLabel={composerPlaceholder(runActive, liveKind).replace('...', '')}
          placeholderTextColor={p.textFaint}
          multiline
          editable={!send.isPending}
          style={{ flex: 1, color: p.text, fontFamily: fonts.regular, fontSize: 16, maxHeight: 140, paddingTop: 10, paddingBottom: 10 }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!message.trim() || send.isPending}
          onPress={() => send.mutate()}
          style={({ pressed }) => ({ width: 40, height: 40, borderRadius: radius + 2, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', opacity: !message.trim() || send.isPending ? 0.45 : pressed ? 0.8 : 1 })}
        >
          {send.isPending ? <ActivityIndicator size="small" color={p.onBrand} /> : <T style={{ color: p.onBrand, fontFamily: fonts.bold, fontSize: 18, lineHeight: 20 }}>↑</T>}
        </Pressable>
      </View>
      <T variant="faint" style={{ paddingBottom: 4 }}>{composerHint(runActive, liveKind, latestAgent?.name, resumes)}</T>
    </View>}
  </View>;
}

function RunSection({ run, agentName, block, liveEvents, draft, showTools }: {
  run: AgentRun; agentName: string; block: ConversationBlock | undefined; liveEvents: AgentEvent[] | null; draft: string; showTools: boolean;
}) {
  const p = usePalette();
  const { client } = useSession();
  const [earlier, setEarlier] = useState<{ events: AgentEvent[]; firstSeq: number | null; remaining: number } | null>(null);
  useEffect(() => setEarlier(null), [run.id]);
  const loadEarlier = useMutation({
    mutationFn: () => client.getEventsBefore(run.id, (earlier?.firstSeq ?? block?.firstSeq)!),
    onSuccess: page => setEarlier(current => ({ events: [...page.events, ...(current?.events ?? [])], firstSeq: page.firstSeq, remaining: page.earlier })),
  });
  const events = liveEvents ?? [...(earlier?.events ?? []), ...(block?.events ?? [])];
  const remaining = liveEvents ? 0 : earlier ? earlier.remaining : block?.earlier ?? 0;
  const items = toChatItems(events, agentName, run.id);
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: p.line }} />
      <T variant="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{agentName} · {runTime(run.queuedAt)} · {runWords(run.status)}</T>
      <View style={{ flex: 1, height: 1, backgroundColor: p.line }} />
    </View>
    {remaining > 0 && <Pressable accessibilityRole="button" onPress={() => loadEarlier.mutate()} disabled={loadEarlier.isPending} style={{ alignSelf: 'center', padding: 8 }}>
      <T variant="dim">{loadEarlier.isPending ? 'Loading...' : `Load earlier messages (${remaining})`}</T>
    </Pressable>}
    <ErrorMessage error={loadEarlier.error} />
    {items.length === 0 && !draft && <T variant="dim">{isRunActive(run.status) ? 'Waiting for output...' : 'This run left no transcript.'}</T>}
    {items.map(item => <ChatRow key={item.key} item={item} showTools={showTools} />)}
    {draft ? <Bubble role="assistant" speaker={agentName} text={draft} faded /> : null}
  </View>;
}

function ChatRow({ item, showTools }: { item: ChatItem; showTools: boolean }) {
  const p = usePalette();
  if (item.kind === 'message') {
    if (item.role === 'system') return <T variant="faint" style={{ textAlign: 'center', paddingHorizontal: 12 }}>{item.text}</T>;
    return <Bubble role={item.role} speaker={item.speaker} text={item.text} />;
  }
  if (item.kind === 'tools') return <ToolCalls calls={item.calls} open={showTools} />;
  const tone = item.interrupted ? p.idle : item.ok ? p.succeeded : p.failed;
  const text = item.interrupted ? 'turn stopped' : item.ok ? `finished${formatCost(item.costUsd) ? ` · ${formatCost(item.costUsd)}` : ''}` : `failed: ${item.error ?? 'no reason reported'}`;
  return <View style={{ alignSelf: item.ok || item.interrupted ? 'center' : 'stretch', borderWidth: 1, borderColor: tone, borderRadius: radius + 1, paddingHorizontal: 12, paddingVertical: 8 }}>
    <T selectable style={{ color: tone, fontFamily: fonts.regular, fontSize: 14, textAlign: item.ok || item.interrupted ? 'center' : 'left' }}>{text}</T>
  </View>;
}

export function Bubble({ role, speaker, text, faded }: { role: 'assistant' | 'user'; speaker: string; text: string; faded?: boolean }) {
  const p = usePalette();
  const user = role === 'user';
  return <View style={{
    alignSelf: user ? 'flex-end' : 'flex-start',
    maxWidth: '90%',
    backgroundColor: user ? p.userBubble : p.panelRaised,
    borderWidth: 1,
    borderColor: user ? p.userBubbleLine : p.line,
    borderRadius: radiusLg + 2,
    paddingHorizontal: 13,
    paddingVertical: 10,
    gap: 4,
    opacity: faded ? 0.7 : 1,
  }}>
    <T style={{ color: p.textDim, fontFamily: fonts.semibold, fontSize: 12 }}>{speaker}</T>
    <T selectable variant="body">{text}</T>
  </View>;
}

function ToolCalls({ calls, open: openAll }: { calls: { name: string; summary: string }[]; open: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const expanded = open || openAll;
  return <View style={{ alignSelf: expanded ? 'stretch' : 'flex-start', borderWidth: 1, borderColor: p.line, borderRadius: radiusLg, overflow: 'hidden' }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setOpen(on => !on)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9 }}>
      <T style={{ color: p.textFaint, fontFamily: fonts.mono, fontSize: 10 }}>{expanded ? '▾' : '▸'}</T>
      <T style={{ color: p.textDim, fontFamily: fonts.mono, fontSize: 12 }}>Tool calls</T>
      <T style={{ color: p.textFaint, fontFamily: fonts.mono, fontSize: 12 }}>{calls.length} {calls.length === 1 ? 'call' : 'calls'}</T>
    </Pressable>
    {expanded && <View style={{ borderTopWidth: 1, borderTopColor: p.line, paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
      {calls.map((call, i) => <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
        <T style={{ color: p.text, fontFamily: fonts.monoMedium, fontSize: 12 }}>{call.name}</T>
        <T selectable numberOfLines={2} style={{ flex: 1, color: p.textFaint, fontFamily: fonts.mono, fontSize: 12 }}>{call.summary}</T>
      </View>)}
    </View>}
  </View>;
}
