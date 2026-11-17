import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { ago, artifactBaseName, kindExt } from '../../src/board-model';
import { ArtifactView } from '../../src/artifact-viewer';
import { useSession } from '../../src/session';
import { Sheet, SheetItem } from '../../src/sheet';
import { fonts, radius, usePalette } from '../../src/theme';
import { Button, Chip, DownMark, Empty, ErrorMessage, Loading, T } from '../../src/ui';

export default function CardArtifacts() {
  const { id, artifact: initial } = useLocalSearchParams<{ id: string; artifact?: string }>();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { client } = useSession();
  const [chosen, setChosen] = useState<string | null>(initial ?? null);
  const [files, setFiles] = useState(false);
  const detail = useQuery({
    queryKey: ['card-artifacts-detail', id],
    queryFn: async () => {
      const [card, artifacts] = await Promise.all([client.getFeature(id).catch(() => null), client.listArtifacts(id)]);
      return { title: card?.title ?? null, artifacts: artifacts.slice(0, 200) };
    },
  });
  const artifacts = detail.data?.artifacts ?? [];
  const selected = artifacts.find(item => item.id === chosen) ?? artifacts[0];
  const count = artifacts.length === 1 ? '1 file' : `${artifacts.length} files`;

  return <View style={{ flex: 1, backgroundColor: p.bg, paddingTop: insets.top }}>
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: p.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to Artifacts" hitSlop={10} onPress={() => router.canGoBack() ? router.back() : router.replace('/artifacts')}>
          <T style={{ color: p.textDim, fontFamily: fonts.medium, fontSize: 16 }}>‹ Artifacts</T>
        </Pressable>
        <Button compact title="Open card" onPress={() => router.push({ pathname: '/card/[id]', params: { id } })} />
      </View>
      <T variant="title" numberOfLines={2} style={{ fontSize: 22, lineHeight: 28 }}>{detail.data?.title ?? 'Card'}</T>
      {selected && <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${count}. Showing ${artifactBaseName(selected.path)}. Choose another file.`}
        onPress={() => setFiles(true)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: p.fieldLine, borderRadius: radius + 1, paddingHorizontal: 12, minHeight: 44 }}
      >
        <T variant="faint">{count}</T>
        <T variant="body" numberOfLines={1} style={{ flex: 1 }}>{artifactBaseName(selected.path)}</T>
        <DownMark />
      </Pressable>}
    </View>
    {detail.isPending ? <Loading />
      : detail.error ? <View style={{ padding: 16 }}><ErrorMessage error={detail.error} /></View>
      : !selected ? <Empty title="No artifacts on this card" body="When an agent produces a write up, mockup, or screenshot here, it will show up." />
      : <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12, flexGrow: 1 }}>
          <View style={{ gap: 2 }}>
            <T variant="label">{artifactBaseName(selected.path)}</T>
            <T variant="faint" selectable numberOfLines={2}>{selected.path} · {selected.stageName} · {ago(selected.createdAt)}</T>
          </View>
          <ArtifactView key={selected.id} artifact={selected} />
        </ScrollView>}
    <Sheet visible={files} onClose={() => setFiles(false)} title={count}>
      {artifacts.map(item => <SheetItem
        key={item.id}
        label={artifactBaseName(item.path)}
        detail={`${item.stageName} · ${ago(item.createdAt)}`}
        leading={<Chip>{kindExt(item.kind, item.path)}</Chip>}
        selected={item.id === selected?.id}
        onPress={() => { setChosen(item.id); setFiles(false); }}
      />)}
      {artifacts.length >= 200 && <T variant="faint" style={{ paddingHorizontal: 20, paddingVertical: 8 }}>Showing the 200 most recent artifacts.</T>}
    </Sheet>
  </View>;
}
