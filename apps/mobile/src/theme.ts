import { useColorScheme } from 'react-native';

// The console's palette (apps/web/src/styles.css). Status hues are reserved:
// blue running, green succeeded, coral failed, gold gated.
const dark = {
  bg: '#0e0d0b',
  panel: '#161411',
  panelRaised: '#1d1b17',
  line: '#2a2722',
  lineBright: '#3d392f',
  fieldLine: '#6d6759',
  text: '#ededed',
  textDim: '#a8a49b',
  textFaint: '#8b867c',
  brand: '#ff8a3d',
  onBrand: '#0e0d0b',
  running: '#4da3ff',
  succeeded: '#3fbf7f',
  failed: '#ff6b5e',
  gated: '#f2c40d',
  idle: '#6d675c',
  backdrop: 'rgba(10, 9, 7, 0.66)',
  userBubble: '#2e231a',
  userBubbleLine: '#6b4527',
};

const light: typeof dark = {
  bg: '#f2f1ed',
  panel: '#f9f8f5',
  panelRaised: '#ffffff',
  line: '#e2dfd8',
  lineBright: '#c9c4b9',
  fieldLine: '#877f6f',
  text: '#1d1a14',
  textDim: '#575145',
  textFaint: '#6b6455',
  brand: '#b34a00',
  onBrand: '#ffffff',
  running: '#0f62d6',
  succeeded: '#0d7a4a',
  failed: '#c22f21',
  gated: '#806000',
  idle: '#746d5f',
  backdrop: 'rgba(29, 26, 20, 0.4)',
  userBubble: '#f6e7da',
  userBubbleLine: '#d9b08f',
};

export type Palette = typeof dark;

export function usePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark;
}

export const fonts = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
};

export const radius = 7;
export const radiusLg = 12;

export type Tone = 'running' | 'succeeded' | 'failed' | 'gated' | 'idle' | 'cancelled';

export function toneColor(palette: Palette, tone: Tone): string {
  return tone === 'cancelled' ? palette.idle : palette[tone];
}
