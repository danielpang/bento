import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { statusTone, statusWords } from '../../src/board-model';
import { useCard } from '../../src/card-data';
import { Conversation } from '../../src/conversation';
import { fonts, usePalette } from '../../src/theme';
import { Chip, T } from '../../src/ui';

export default function SessionPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const card = useCard(id);
  const feature = card.data?.card;
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.bg, paddingTop: insets.top, paddingBottom: insets.bottom }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.canGoBack() ? router.back() : router.replace('/sessions')} hitSlop={10}>
        <T style={{ color: p.textDim, fontFamily: fonts.medium, fontSize: 16 }}>‹ Back</T>
      </Pressable>
      <T numberOfLines={1} style={{ flex: 1, color: p.text, fontFamily: fonts.semibold, fontSize: 17 }}>{feature?.title ?? 'Conversation'}</T>
      {feature && <Chip tone={statusTone(feature.status)}>{statusWords(feature.status)}</Chip>}
    </View>
    {card.data?.card.standalone === false && <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/card/[id]', params: { id } })} style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
      <T style={{ color: p.brand, fontFamily: fonts.medium }}>Open card</T>
    </Pressable>}
    <Conversation featureId={id} />
  </KeyboardAvoidingView>;
}
