import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from '@expo-google-fonts/geist';
import { GeistMono_400Regular, GeistMono_500Medium } from '@expo-google-fonts/geist-mono';
import { ProjectProvider } from '../src/project';
import { SessionProvider, useSession } from '../src/session';
import { usePalette } from '../src/theme';

function Navigation() {
  const { authenticated, generation } = useSession();
  const p = usePalette();
  const stack = <Stack key={generation} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.bg } }}>
    <Stack.Screen name="index" />
    <Stack.Protected guard={authenticated}>
      <Stack.Screen name="board" options={{ animation: 'none' }} />
      <Stack.Screen name="sessions" options={{ animation: 'none' }} />
      <Stack.Screen name="artifacts/index" options={{ animation: 'none' }} />
      <Stack.Screen name="artifacts/[id]" />
      <Stack.Screen name="session/[id]" />
      <Stack.Screen name="card/[id]" options={{ presentation: 'modal', contentStyle: { backgroundColor: p.panel } }} />
      <Stack.Screen name="new-card" options={{ presentation: 'modal' }} />
      <Stack.Screen name="new-session" options={{ presentation: 'modal' }} />
    </Stack.Protected>
  </Stack>;
  return authenticated ? <ProjectProvider key={generation}>{stack}</ProjectProvider> : stack;
}

export default function Layout() {
  const p = usePalette();
  const [loaded] = useFonts({ Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold, GeistMono_400Regular, GeistMono_500Medium });
  if (!loaded) return <View style={{ flex: 1, backgroundColor: p.bg }} />;
  return <SessionProvider><StatusBar style="auto" /><Navigation /></SessionProvider>;
}
