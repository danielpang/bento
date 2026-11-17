import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import { fonts, radius, radiusLg, toneColor, usePalette, type Tone } from './theme';

type Variant = 'body' | 'dim' | 'faint' | 'title' | 'heading' | 'label' | 'mono' | 'small';

export function T({ variant = 'body', style, ...props }: TextProps & { variant?: Variant }) {
  const p = usePalette();
  const base: Record<Variant, TextStyle> = {
    body: { color: p.text, fontFamily: fonts.regular, fontSize: 15, lineHeight: 22 },
    dim: { color: p.textDim, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
    faint: { color: p.textFaint, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
    small: { color: p.textDim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 16 },
    title: { color: p.text, fontFamily: fonts.semibold, fontSize: 26, lineHeight: 32, letterSpacing: -0.5 },
    heading: { color: p.text, fontFamily: fonts.semibold, fontSize: 16, lineHeight: 22 },
    label: { color: p.text, fontFamily: fonts.semibold, fontSize: 14, lineHeight: 20 },
    mono: { color: p.textFaint, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
  };
  return <Text {...props} style={[base[variant], style]} />;
}

export function Button({ title, onPress, disabled, kind = 'default', style, compact }: {
  title: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'default' | 'ghost'; style?: StyleProp<ViewStyle>; compact?: boolean;
}) {
  const p = usePalette();
  const primary = kind === 'primary';
  return <Pressable
    accessibilityRole="button"
    accessibilityState={{ disabled: Boolean(disabled) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [{
      minHeight: compact ? 36 : 44,
      paddingHorizontal: compact ? 12 : 16,
      borderRadius: radius + 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: primary ? p.brand : kind === 'ghost' ? 'transparent' : p.panel,
      borderWidth: kind === 'ghost' ? 0 : 1,
      borderColor: primary ? p.brand : p.lineBright,
      opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
    }, style]}
  >
    <Text style={{ color: primary ? p.onBrand : p.text, fontFamily: fonts.semibold, fontSize: compact ? 14 : 15 }}>{title}</Text>
  </Pressable>;
}

export function Dot({ tone, size = 7 }: { tone: Tone; size?: number }) {
  const p = usePalette();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColor(p, tone) }} />;
}

export function Chip({ children, tone }: PropsWithChildren<{ tone?: Tone }>) {
  const p = usePalette();
  const color = tone ? toneColor(p, tone) : p.textDim;
  return <View style={{ borderWidth: 1, borderColor: tone ? color : p.lineBright, borderRadius: tone ? 5 : 4, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: tone ? 'transparent' : p.bg, alignSelf: 'flex-start' }}>
    <Text style={{ color, fontFamily: fonts.mono, fontSize: 11 }}>{children}</Text>
  </View>;
}

export function Panel({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const p = usePalette();
  return <View style={[{ backgroundColor: p.panel, borderWidth: 1, borderColor: p.line, borderRadius: radiusLg, padding: 16, gap: 12 }, style]}>{children}</View>;
}

export function Field({ style, ...props }: TextInputProps) {
  const p = usePalette();
  return <TextInput
    placeholderTextColor={p.textFaint}
    {...props}
    style={[{ color: p.text, fontFamily: fonts.regular, fontSize: 16, borderWidth: 1, borderColor: p.fieldLine, borderRadius: radius + 1, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, backgroundColor: p.bg }, style]}
  />;
}

export function SearchField({ value, onChangeText, placeholder, style }: { value: string; onChangeText: (value: string) => void; placeholder: string; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: p.fieldLine, borderRadius: radius + 1, paddingHorizontal: 10, minHeight: 40, backgroundColor: p.bg }, style]}>
    <SearchMark />
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={p.textFaint}
      autoCapitalize="none"
      autoCorrect={false}
      clearButtonMode="while-editing"
      returnKeyType="search"
      accessibilityLabel={placeholder}
      style={{ flex: 1, color: p.text, fontFamily: fonts.regular, fontSize: 15, paddingVertical: 8 }}
    />
  </View>;
}

function SearchMark() {
  const p = usePalette();
  return <View accessible={false} style={{ width: 14, height: 14 }}>
    <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 1.6, borderColor: p.textFaint }} />
    <View style={{ position: 'absolute', width: 5, height: 1.6, backgroundColor: p.textFaint, right: 0, bottom: 2, transform: [{ rotate: '45deg' }] }} />
  </View>;
}

export function ErrorMessage({ error }: { error: unknown }) {
  const p = usePalette();
  if (!error) return null;
  return <View style={{ borderWidth: 1, borderColor: p.failed, borderRadius: radius + 1, padding: 12 }}>
    <Text accessibilityRole="alert" style={{ color: p.failed, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 }}>{error instanceof Error ? error.message : String(error)}</Text>
  </View>;
}

export function Loading() {
  const p = usePalette();
  return <ActivityIndicator color={p.textDim} accessibilityLabel="Loading" style={{ margin: 24 }} />;
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return <View style={{ alignItems: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 16 }}>
    <T variant="label" style={{ textAlign: 'center' }}>{title}</T>
    {body ? <T variant="dim" style={{ textAlign: 'center' }}>{body}</T> : null}
    {action}
  </View>;
}

export function Divider() {
  const p = usePalette();
  return <View style={{ height: 1, backgroundColor: p.line }} />;
}

function Chevron({ up, color, size }: { up?: boolean; color: string; size: number }) {
  return <View style={{ width: size, height: size, borderRightWidth: 1.6, borderBottomWidth: 1.6, borderColor: color, transform: [{ rotate: up ? '-135deg' : '45deg' }] }} />;
}

/** The picker mark: a chevron up over a chevron down, centred on one axis. */
export function UpDownMark() {
  const p = usePalette();
  return <View accessible={false} style={{ width: 12, height: 16, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
    <Chevron up color={p.textDim} size={5} />
    <Chevron color={p.textDim} size={5} />
  </View>;
}

export function DownMark() {
  const p = usePalette();
  return <View accessible={false} style={{ width: 12, height: 12, alignItems: 'center', justifyContent: 'center', paddingBottom: 3 }}>
    <Chevron color={p.textDim} size={6} />
  </View>;
}
