import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { DeviceFlow, type DeviceCodeResponse } from '@bento/api-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { mobileFetch, useSession } from '../src/session';
import { serverOrigin, verificationUrl } from '../src/model';
import { Button, ErrorMessage, Input, Loading, Screen, styles } from '../src/ui';

function SignIn() {
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
      const origin = serverOrigin(address);
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
  return <Screen>
    <Text style={styles.muted}>YOUR AGENTS, WITH YOU</Text>
    <Text style={styles.title}>Keep good work moving.</Text>
    <Text style={styles.text}>Follow your coding agents, answer questions, and move your next feature forward.</Text>
    <View style={styles.card}>
      <Input label="Bento server" value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} />
      <Text style={styles.muted}>Sign in securely in your browser, then return to Bento.</Text>
      {code && <><Text style={styles.muted}>Approve this code in your browser</Text><Text selectable style={styles.title}>{code.user_code}</Text><Text style={styles.muted}>Waiting for approval. Return here after approving.</Text></>}
      <ErrorMessage error={error} />
      <Button title={busy ? 'Waiting for sign-in…' : 'Sign in to Bento'} disabled={busy} onPress={() => void login()} />
      {busy && <Button secondary title="Cancel sign-in" onPress={() => { attempt.current?.abort(); setBusy(false); setCode(undefined); }} />}
    </View>
  </Screen>;
}
function Projects() {
  const { client, switchTeam, disconnect } = useSession();
  const account = useQuery({ queryKey: ['account'], queryFn: () => client.getAccountSession() });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => client.listOrganizations() });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => client.listProjects() });
  const team = useMutation({ mutationFn: switchTeam });
  const logout = useMutation({ mutationFn: disconnect });
  return <Screen>
    <Text style={styles.muted}>WORKSPACE</Text>
    <Text style={styles.title}>Your projects</Text>
    <Text style={styles.muted}>Pick up where your agents left off.</Text>
    <View style={styles.row}>{teams.data?.map(item => <Button key={item.id} title={item.name} secondary={item.id !== account.data?.session.activeOrganizationId} disabled={team.isPending} onPress={() => team.mutate(item.id)} />)}</View>
    <ErrorMessage error={account.error || teams.error || projects.error || team.error || logout.error} />
    {(projects.isPending || teams.isPending) && <Loading />}
    {projects.data?.map(project => <View style={styles.card} key={project.id}><Text style={styles.heading}>{project.name}</Text><Text style={styles.muted}>{project.repoUrl || 'Connected workspace'}</Text><Button secondary title="Open project" onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })} /></View>)}
    {projects.data?.length === 0 && <View style={styles.card}><Text style={styles.heading}>No projects yet</Text><Text style={styles.muted}>Create a project and connect a repository in Bento on the web. Your projects will appear here.</Text></View>}
    <Button secondary title="Refresh projects" disabled={projects.isFetching} onPress={() => { void projects.refetch(); void teams.refetch(); void account.refetch(); }} />
    <Button secondary title={logout.isPending ? 'Signing out…' : 'Sign out'} disabled={logout.isPending} onPress={() => logout.mutate()} />
  </Screen>;
}
export default function Home() {
  return useSession().authenticated ? <Projects /> : <SignIn />;
}
