import type { PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
export const colors = { bg: '#101512', panel: '#1b231e', border: '#334239', text: '#f4f6ed', muted: '#a2b0a5', accent: '#c8ee9b', error: '#ffb6ab' };
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 22, gap: 16, paddingBottom: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 30, fontWeight: '700', letterSpacing: -0.8 },
  heading: { color: colors.text, fontSize: 19, fontWeight: '600' },
  text: { color: colors.text, fontSize: 16, lineHeight: 24 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  card: { backgroundColor: colors.panel, borderRadius: 18, padding: 18, gap: 10, borderWidth: 1, borderColor: colors.border },
  input: { backgroundColor: colors.panel, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, fontSize: 16, minHeight: 48 },
});
export function Screen({ children }: PropsWithChildren) {
  return <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>{children}</ScrollView></SafeAreaView>;
}
export function Button({ title, onPress, disabled, secondary = false }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ paddingVertical: 13, paddingHorizontal: 18, borderRadius: 12, minHeight: 48, backgroundColor: secondary ? colors.panel : colors.accent, borderWidth: 1, borderColor: secondary ? colors.border : colors.accent, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 })}><Text style={{ color: secondary ? colors.text : colors.bg, fontSize: 15, fontWeight: '600', textAlign: 'center' }}>{title}</Text></Pressable>;
}
export function Input({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={{ gap: 7 }}><Text style={styles.muted}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} {...props} style={[styles.input, props.multiline && { minHeight: 100, textAlignVertical: 'top' }, props.style]} /></View>;
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? <Text accessibilityRole="alert" style={{ color: colors.error, lineHeight: 22 }}>{error instanceof Error ? error.message : String(error)}</Text> : null;
}
export function Loading() { return <ActivityIndicator color={colors.accent} accessibilityLabel="Loading" style={{ margin: 24 }} />; }
