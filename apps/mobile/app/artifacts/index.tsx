import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { ProjectArtifactCard } from '@bento/api-client';
import { ago, artifactBaseName, kindExt } from '../../src/board-model';
import { ImageThumb, MarkdownView } from '../../src/artifact-viewer';
import { useProject } from '../../src/project';
import { useSession } from '../../src/session';
import { Shell } from '../../src/shell';
import { fonts, radius, radiusLg, usePalette } from '../../src/theme';
import { Button, Chip, Empty, ErrorMessage, Loading, SearchField, T } from '../../src/ui';

export default function Artifacts() {
  return <Shell><Grid /></Shell>;
}

function Grid() {
  const p = usePalette();
  const { client } = useSession();
  const { project } = useProject();
  const projectId = project!.id;
  const [query, setQuery] = useState('');
  const cards = useQuery({ queryKey: ['project-artifacts', projectId], queryFn: () => client.listProjectArtifacts(projectId) });
  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!cards.data) return [];
    if (!term) return cards.data.map(card => ({ card, files: [] as string[] }));
    return cards.data.flatMap(card => {
      const files = card.paths.map(artifactBaseName).filter(name => name.toLowerCase().includes(term));
      return card.title.toLowerCase().includes(term) || files.length > 0 ? [{ card, files }] : [];
    });
  }, [cards.data, query]);

  const header = <View style={{ gap: 14, marginBottom: 18, marginTop: 4 }}>
    <View style={{ gap: 4 }}>
      <T variant="title">Artifacts</T>
      <T variant="dim">Everything your agents produced, by card.</T>
    </View>
    <SearchField value={query} onChangeText={setQuery} placeholder="Search cards and file names" />
  </View>;

  if (cards.isPending) return <Loading />;
  if (cards.error) return <View style={{ padding: 16 }}><ErrorMessage error={cards.error} /></View>;
  return <FlatList
    data={results}
    keyExtractor={item => item.card.featureId}
    keyboardShouldPersistTaps="handled"
    refreshControl={<RefreshControl refreshing={cards.isRefetching} onRefresh={() => void cards.refetch()} tintColor={p.textDim} />}
    contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 22 }}
    ListHeaderComponent={header}
    ListEmptyComponent={cards.data.length === 0
      ? <Empty title="No artifacts yet" body="When an agent produces a write up, mockup, or screenshot on a card, it will show up here." action={<Button title="Go to Board" onPress={() => router.replace('/board')} />} />
      : <Empty title={`No artifacts match “${query.trim()}”`} body="Search looks at card titles and file names." action={<Button title="Clear search" onPress={() => setQuery('')} />} />}
    renderItem={({ item }) => <Tile card={item.card} files={item.files} />}
  />;
}

function Tile({ card, files }: { card: ProjectArtifactCard; files: string[] }) {
  const p = usePalette();
  const count = card.artifactCount === 1 ? '1 artifact' : `${card.artifactCount} artifacts`;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={`${card.title}, ${count}, updated ${ago(card.latestCreatedAt)}`}
    onPress={() => router.push({ pathname: '/artifacts/[id]', params: { id: card.featureId } })}
    style={({ pressed }) => ({ gap: 10, opacity: pressed ? 0.85 : 1 })}
  >
    <View style={{ height: 180, borderWidth: 1, borderColor: p.line, borderRadius: radiusLg + 4, backgroundColor: p.panel, overflow: 'hidden', padding: 16 }}>
      <TilePreview card={card} />
    </View>
    <View style={{ paddingHorizontal: 2, gap: 4 }}>
      <T variant="label" numberOfLines={2} style={{ fontSize: 16 }}>{card.title}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <T variant="dim">{count} · Updated {ago(card.latestCreatedAt)}</T>
        <View style={{ flexDirection: 'row', gap: 6 }}>{card.kinds.map(kind => <Chip key={kind}>{kindExt(kind)}</Chip>)}</View>
      </View>
      {files.length > 0 && <T variant="faint" numberOfLines={2}>{files.slice(0, 3).join(', ')}{files.length > 3 ? ` +${files.length - 3} more` : ''}</T>}
    </View>
  </Pressable>;
}

function TilePreview({ card }: { card: ProjectArtifactCard }) {
  if (card.preview.kind === 'markdown' && card.preview.markdownExcerpt) {
    return <View pointerEvents="none"><MarkdownView text={card.preview.markdownExcerpt} compact /></View>;
  }
  if (card.preview.kind === 'image') return <ImageThumb artifactId={card.preview.artifactId} fallback={<Sketch kind="image" />} />;
  return <Sketch kind={card.preview.kind} />;
}

/** A drawn placeholder, the way the console sketches a page or a diagram it does not render in a tile. */
function Sketch({ kind }: { kind: string }) {
  const p = usePalette();
  const bar = (width: number | `${number}%`, height = 10, color = p.lineBright) => <View style={{ width, height, borderRadius: 3, backgroundColor: color }} />;
  if (kind === 'mermaid') {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <View style={{ flexDirection: 'row', gap: 24 }}>{[0, 1].map(i => <View key={i} style={{ width: 70, height: 30, borderRadius: radius, borderWidth: 1, borderColor: p.lineBright }} />)}</View>
      <View style={{ width: 2, height: 18, backgroundColor: p.lineBright }} />
      <View style={{ width: 90, height: 30, borderRadius: radius, borderWidth: 1, borderColor: p.brand }} />
    </View>;
  }
  return <View style={{ flex: 1, borderWidth: 1, borderColor: p.line, borderRadius: radius + 2, backgroundColor: p.panelRaised, overflow: 'hidden' }}>
    <View style={{ flexDirection: 'row', gap: 5, padding: 8, borderBottomWidth: 1, borderBottomColor: p.line }}>
      {[0, 1, 2].map(i => <View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.lineBright }} />)}
    </View>
    <View style={{ flex: 1, flexDirection: 'row', padding: 12, gap: 12 }}>
      <View style={{ flex: 2, gap: 8 }}>
        {bar('60%', 8)}
        <View style={{ height: 18, borderRadius: 4, borderWidth: 1, borderColor: p.line }} />
        <View style={{ height: 18, borderRadius: 4, borderWidth: 1, borderColor: p.line }} />
        {bar('40%', 18, p.textDim)}
      </View>
      <View style={{ flex: 1, borderRadius: 4, borderWidth: 1, borderColor: p.line }} />
    </View>
    {kind === 'file' || kind === 'image' ? <View style={{ position: 'absolute', right: 10, bottom: 8 }}><T style={{ color: p.textFaint, fontFamily: fonts.mono, fontSize: 10 }}>{kind === 'image' ? 'IMG' : 'FILE'}</T></View> : null}
  </View>;
}
