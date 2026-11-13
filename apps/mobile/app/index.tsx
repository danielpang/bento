import { useEffect, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { DeviceFlow, type DeviceCodeResponse } from '@bento/api-client';
import { mobileFetch, useSession } from '../src/session';
import { serverOrigin, verificationUrl } from '../src/model';
import { fonts, usePalette } from '../src/theme';
import { Button, ErrorMessage, Field, Panel, T } from '../src/ui';

function SignIn() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [address, setAddress] = useState(session.origin);
  const [code, setCode] = useState<DeviceCodeResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);
  async function login() {
    const controller = new AbortController();
    attempt.current?.abort();
    attempt.current = controller;
    setBusy(true); setError(undefined); setCode(undefined);
    try {
      const origin = serverOrigin(address, { allowHttp: __DEV__ });
      const flow = new DeviceFlow({ baseUrl: origin, clientId: 'bento-mobile', signal: controller.signal, fetch: (url, init) => mobileFetch(url, { ...init, signal: controller.signal }) });
      const next = await flow.requestCode();
      if (controller.signal.aborted) return;
      const url = verificationUrl(origin, next.verification_uri_complete ?? next.verification_uri);
      setCode(next);
      // Polling starts immediately. iOS may suspend it while Safari is open;
      // returning to Bento resumes the pending authorization.
      void WebBrowser.openBrowserAsync(url).catch(err => {
        if (!controller.signal.aborted) setError(err);
      });
      const token = await flow.pollForToken(next);
      if (!controller.signal.aborted) await session.connect({ origin, token });
    } catch (err) {
      if (!controller.signal.aborted) setError(err);
    } finally {
      if (attempt.current === controller) { setBusy(false); setCode(undefined); }
    }
  }
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, paddingTop: insets.top + 24, gap: 24 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Image source={require('../assets/logo.png')} style={{ width: 34, height: 34, borderRadius: 8 }} accessibilityIgnoresInvertColors />
          <T style={{ color: p.text, fontFamily: fonts.semibold, fontSize: 22 }}>Bento</T>
        </View>
        <T variant="title">Sign in to Bento</T>
        <T variant="dim">One card, one agent, one branch.</T>
      </View>
      <Panel>
        <View style={{ gap: 6 }}>
          <T variant="small">Bento server</T>
          <Field value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} accessibilityLabel="Bento server" />
        </View>
        <T variant="dim">Sign in securely in your browser, then return to Bento.</T>
        {code && <View style={{ gap: 6 }}>
          <T variant="dim">Approve this code in your browser</T>
          <T selectable style={{ color: p.text, fontFamily: fonts.monoMedium, fontSize: 28, letterSpacing: 2 }}>{code.user_code}</T>
          <T variant="faint">Waiting for approval. Return here after approving.</T>
        </View>}
        <ErrorMessage error={error} />
        <Button kind="primary" title={busy ? 'Waiting for sign-in…' : 'Sign in to Bento'} disabled={busy} onPress={() => void login()} />
        {busy && <Button title="Cancel sign-in" onPress={() => { attempt.current?.abort(); setBusy(false); setCode(undefined); }} />}
      </Panel>
    </ScrollView>
  </KeyboardAvoidingView>;
}

export default function Home() {
  return useSession().authenticated ? <Redirect href="/board" /> : <SignIn />;
}
