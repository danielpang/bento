import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ConversationBlock } from '@bento/api-client';
import { useForeground, useSession } from '../../src/session';
import { eventText } from '../../src/model';
import { Button, ErrorMessage, Input, Loading, Screen, styles } from '../../src/ui';
import { Questions } from '../../src/questions';
import { LiveTranscript } from '../../src/transcript';

function HistoryBlock({ block }: { block: ConversationBlock }) {
  const { client } = useSession();
  const [events, setEvents] = useState(block.events);
  const [firstSeq, setFirstSeq] = useState(block.firstSeq);
  const [earlier, setEarlier] = useState(block.earlier);
  const load = useMutation({ mutationFn: () => client.getEventsBefore(block.runId, firstSeq!), onSuccess: page => {
    setEvents(current => [...page.events, ...current]); setFirstSeq(page.firstSeq); setEarlier(page.earlier);
  } });
  return <View style={{ gap: 12 }}><Text style={styles.heading}>{block.agentName} · {block.status}</Text>
    {earlier > 0 && firstSeq !== null && <Button secondary title={load.isPending ? 'Loading…' : `Load earlier messages (${earlier})`} disabled={load.isPending} onPress={() => load.mutate()} />}
    <ErrorMessage error={load.error} />
    {events.map((event, index) => <View key={index} style={styles.card}><Text style={styles.muted}>{event.type === 'message' ? event.role : 'Activity'}</Text><Text selectable style={styles.text}>{eventText(event)}</Text></View>)}
  </View>;
}
export default function Card() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useSession();
  const active = useForeground();
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const query = useQuery({ queryKey: ['card', id], queryFn: async () => {
    const [card, conversation] = await Promise.all([client.getFeature(id), client.getConversation(id)]);
    const runs = card.runs.filter(run => ['queued', 'starting', 'running'].includes(run.status));
    const questions = (await Promise.all(runs.map(run => client.listRunQuestions(run.id)))).flat();
    return { card, conversation, runs, questions };
  }, refetchInterval: active ? 10_000 : false });
  const projectId = query.data?.card.projectId;
  useEffect(() => {
    if (!active || !projectId) return;
    void query.refetch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void query.refetch(); }, 300); };
    const stop = client.streamBoard(projectId, refresh, refresh);
    return () => { stop(); clearTimeout(timer); };
  }, [active, client, projectId]);
  const action = useMutation({ mutationFn: async (kind: 'message' | 'approve' | 'advance') => {
    if (kind === 'message') {
      const result = await client.messageFeature(id, message.trim());
      setMessage(''); setNotice(result.queued ? 'Message queued for your agent.' : 'Message sent to your agent.');
    } else {
      if (kind === 'approve') await client.approveFeature(id); else await client.advanceFeature(id);
      setNotice('Card updated.');
    }
  }, onSuccess: () => { void query.refetch(); } });
  const openPr = useMutation({ mutationFn: async (url: string) => {
    if (new URL(url).protocol !== 'https:') throw new Error('This pull request does not have an HTTPS address.');
    await Linking.openURL(url);
  } });
  const data = query.data;
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}><Screen>
    <Stack.Screen options={{ title: 'Card details' }} />
    <ErrorMessage error={query.error} />{query.isPending && <Loading />}
    {data && <>
      <Text style={styles.muted}>{data.card.status.toUpperCase()}</Text><Text style={styles.title}>{data.card.title}</Text>
      {Boolean(data.card.description) && <Text selectable style={styles.text}>{data.card.description}</Text>}
      <View style={styles.row}>
        {data.card.status === 'gated' && <Button title="Approve stage" disabled={action.isPending} onPress={() => action.mutate('approve')} />}
        {data.card.status === 'backlog' && <Button title="Start pipeline" disabled={action.isPending} onPress={() => action.mutate('advance')} />}
        {data.card.pullRequests.map(pr => <Button key={pr.url} secondary title={`Open PR #${pr.number}`} onPress={() => openPr.mutate(pr.url)} />)}
      </View>
      <ErrorMessage error={action.error || openPr.error} />{notice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text>}
      {data.questions.map(request => <Questions key={request.id} request={request} onAnswered={() => void query.refetch()} />)}
      {data.card.status !== 'done' && data.card.status !== 'cancelled' && <View style={styles.card}>
        <Input label="Message your agent" placeholder="Add context or ask for a change…" value={message} onChangeText={setMessage} multiline editable={!action.isPending} />
        <Button title={action.isPending ? 'Working…' : 'Send message'} disabled={!message.trim() || action.isPending} onPress={() => action.mutate('message')} />
      </View>}
      {data.runs.map(run => <LiveTranscript key={run.id} runId={run.id} onDone={() => void query.refetch()} />)}
      {data.conversation.pending.map(pending => <View key={pending.id} style={styles.card}><Text style={styles.muted}>{pending.status}</Text><Text style={styles.text}>{pending.text}</Text></View>)}
      {data.conversation.blocks.filter(block => !data.runs.some(run => run.id === block.runId)).map(block => <HistoryBlock key={`${block.runId}:${block.events.length}`} block={block} />)}
      {!data.runs.length && !data.conversation.blocks.length && <Text style={styles.muted}>Your conversation will appear here when work begins.</Text>}
    </>}
    <Button secondary title="Refresh card" disabled={query.isFetching} onPress={() => void query.refetch()} />
  </Screen></KeyboardAvoidingView>;
}
