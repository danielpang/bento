import { useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForeground, useSession } from '../../src/session';
import { Button, ErrorMessage, Input, Loading, styles } from '../../src/ui';

export default function Project() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useSession();
  const active = useForeground();
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('all');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const query = useQuery({ queryKey: ['board', id], queryFn: async () => {
    const [cards, pipeline, snapshot] = await Promise.all([client.listFeatures(id), client.getPipeline(id), client.getBoardSnapshot(id)]);
    return { cards, pipeline, snapshot };
  } });
  useEffect(() => {
    if (!active) return;
    void query.refetch();
    // Coalesce bursts of board events into one refresh.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void query.refetch(); }, 300); };
    const stop = client.streamBoard(id, refresh, refresh);
    return () => { stop(); clearTimeout(timer); };
  }, [client, id, active]);
  const create = useMutation({ mutationFn: () => client.createFeature({ projectId: id, title: title.trim(), description: description.trim() }), onSuccess: card => {
    setCreating(false); setTitle(''); setDescription(''); void query.refetch();
    router.push({ pathname: '/card/[id]', params: { id: card.id } });
  } });
  const cards = query.data?.cards.filter(card => !card.standalone && (stage === 'all' || (stage === 'backlog' ? card.currentStageId === null : card.currentStageId === stage)) && `${card.title} ${card.description}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}><Stack.Screen options={{ title: 'Project board' }} /><FlatList
    contentContainerStyle={styles.content} data={cards} keyExtractor={card => card.id}
    refreshing={query.isRefetching} onRefresh={() => void query.refetch()} keyboardShouldPersistTaps="handled"
    ListHeaderComponent={<View style={{ gap: 16 }}>
      <Text style={styles.muted}>PIPELINE</Text><Text style={styles.title}>Keep it moving.</Text>
      <Input label="Search cards" value={search} onChangeText={setSearch} placeholder="Find a feature…" />
      <View style={styles.row}>{[{ id: 'all', name: 'All' }, { id: 'backlog', name: 'Backlog' }, ...(query.data?.pipeline.stages ?? [])].map(item => <Button key={item.id} title={item.name} secondary={stage !== item.id} onPress={() => setStage(item.id)} />)}</View>
      <Button title={creating ? 'Close new card' : '+ New card'} onPress={() => setCreating(!creating)} disabled={create.isPending} />
      {creating && <View style={styles.card}><Input label="Title" value={title} onChangeText={setTitle} /><Input label="Instructions" value={description} onChangeText={setDescription} multiline /><ErrorMessage error={create.error} /><Button title={create.isPending ? 'Creating…' : 'Create card'} disabled={!title.trim() || create.isPending} onPress={() => create.mutate()} /></View>}
      <ErrorMessage error={query.error} />{query.isError && <Button secondary title="Try again" onPress={() => void query.refetch()} />}
      {query.isPending && <Loading />}
    </View>}
    ListEmptyComponent={!query.isPending && !query.isError ? <Text style={styles.muted}>No cards match this view. Create a card to get started.</Text> : null}
    renderItem={({ item }) => <View style={styles.card}>
      <Text style={styles.muted}>{query.data?.pipeline.stages.find(s => s.id === item.currentStageId)?.name ?? 'Backlog'} · {query.data?.snapshot.statuses[item.id] ?? item.status}</Text>
      <Text style={styles.heading}>{item.title}</Text>
      {Boolean(item.description) && <Text numberOfLines={3} style={styles.muted}>{item.description}</Text>}
      {query.data?.snapshot.outputs[item.id] && <Text numberOfLines={2} style={styles.muted}>{query.data.snapshot.outputs[item.id]}</Text>}
      <Button secondary title="Open card" onPress={() => router.push({ pathname: '/card/[id]', params: { id: item.id } })} />
    </View>}
  /></SafeAreaView>;
}
