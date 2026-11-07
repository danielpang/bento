import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider, useSession } from '../src/session';
import { colors } from '../src/ui';
function Navigation() {
  const { authenticated, generation } = useSession();
  return <Stack key={generation} screenOptions={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg }, headerShadowVisible: false }}>
    <Stack.Screen name="index" options={{ title: 'Bento' }} />
    <Stack.Protected guard={authenticated}>
      <Stack.Screen name="project/[id]" options={{ title: 'Project' }} />
      <Stack.Screen name="card/[id]" options={{ title: 'Card' }} />
    </Stack.Protected>
  </Stack>;
}
export default function Layout() {
  return <SessionProvider><StatusBar style="light" /><Navigation /></SessionProvider>;
}
