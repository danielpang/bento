import type { PropsWithChildren } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radiusLg, usePalette } from './theme';
import { T } from './ui';

/** A list that rises from the bottom, for pickers and menus. */
export function Sheet({ visible, onClose, title, children }: PropsWithChildren<{ visible: boolean; onClose: () => void; title?: string }>) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={{ flex: 1, backgroundColor: p.backdrop }} onPress={onClose} />
    <View style={{ backgroundColor: p.panel, borderTopLeftRadius: radiusLg + 4, borderTopRightRadius: radiusLg + 4, borderWidth: 1, borderColor: p.line, paddingBottom: insets.bottom + 8, maxHeight: '75%' }}>
      <View style={{ alignItems: 'center', paddingTop: 8 }}><View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: p.lineBright }} /></View>
      {title ? <T variant="faint" style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 }}>{title}</T> : null}
      <ScrollView contentContainerStyle={{ paddingVertical: 6 }}>{children}</ScrollView>
    </View>
  </Modal>;
}

export function SheetItem({ label, detail, selected, onPress, leading, destructive }: {
  label: string; detail?: string; selected?: boolean; onPress: () => void; leading?: React.ReactNode; destructive?: boolean;
}) {
  const p = usePalette();
  return <Pressable
    accessibilityRole="button"
    accessibilityState={{ selected: Boolean(selected) }}
    onPress={onPress}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 13, backgroundColor: pressed ? p.panelRaised : 'transparent' })}
  >
    {leading}
    <View style={{ flex: 1, gap: 2 }}>
      <T variant="body" style={[selected && { fontFamily: 'Geist_600SemiBold' }, destructive && { color: p.failed }]} numberOfLines={2}>{label}</T>
      {detail ? <T variant="faint" numberOfLines={1}>{detail}</T> : null}
    </View>
    {selected ? <T variant="body" style={{ color: p.brand }}>✓</T> : null}
  </Pressable>;
}
