import { useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MODEL_GUIDANCE, modelStringFor, providersForCli, sessionTitle, type AgentCli } from '@bento/core';
import { useProject } from './project';
import { useSession } from './session';
import { Sheet, SheetItem } from './sheet';
import { fonts, radius, radiusLg, usePalette } from './theme';
import { DownMark, ErrorMessage, Field, T } from './ui';

const HARNESSES = MODEL_GUIDANCE.filter(tool => tool.cli !== 'fake').map(tool => ({ value: tool.cli as AgentCli, label: tool.label, defaultModel: tool.defaultModel }));

function modelOptionsFor(cli: AgentCli) {
  return providersForCli(cli).flatMap(provider => provider.models.map(model => ({ value: modelStringFor(cli, provider.id, model.id), name: model.name, provider: provider.name })));
}

/** New card or new session, the way the web console's composer starts both. */
export function Composer({ card }: { card: boolean }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { client } = useSession();
  const { project } = useProject();
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions', project?.id], queryFn: () => client.listSessions(project!.id), enabled: Boolean(project) });
  const recent = sessions.data?.sessions.find(session => session.latestRun.agentCli && session.latestRun.agentModel)?.latestRun;
  const recentCli = recent && HARNESSES.some(h => h.value === recent.agentCli) ? recent.agentCli as AgentCli : undefined;
  const [cliChoice, setCli] = useState<AgentCli | null>(null);
  const cli = cliChoice ?? recentCli ?? HARNESSES[0].value;
  const [modelChoice, setModel] = useState<string | null>(null);
  const model = modelChoice ?? (recent?.agentCli === cli && recent.agentModel ? recent.agentModel : HARNESSES.find(h => h.value === cli)?.defaultModel ?? '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [startNow, setStartNow] = useState(!card);
  const [picking, setPicking] = useState<'harness' | 'model' | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const models = useMemo(() => modelOptionsFor(cli), [cli]);
  const harness = HARNESSES.find(h => h.value === cli);

  const submit = useMutation({
    mutationFn: async () => {
      const projectId = project!.id;
      const named = title.trim();
      if (card && !startNow) {
        const feature = await client.createFeature({ projectId, title: named || sessionTitle(prompt, 'New card'), description: prompt.trim() });
        return { card: feature.id };
      }
      const { featureId } = await client.startSession(projectId, { cli, model: model.trim(), prompt: prompt.trim(), ...(named ? { title: named } : {}) });
      return { session: featureId };
    },
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if ('card' in result) router.replace({ pathname: '/card/[id]', params: { id: result.card } });
      else router.replace({ pathname: '/session/[id]', params: { id: result.session } });
    },
  });
  const ready = !submit.isPending && prompt.trim() !== '' && (!startNow || model.trim() !== '') && Boolean(project);
  const shownModels = models.filter(option => `${option.name} ${option.value} ${option.provider}`.toLowerCase().includes(modelSearch.trim().toLowerCase()));
  const typed = modelSearch.trim();

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 18 }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={10} disabled={submit.isPending}>
          <T variant="dim" style={{ fontFamily: fonts.medium }}>Cancel</T>
        </Pressable>
      </View>
      <View style={{ gap: 6 }}>
        <T variant="title">{card ? 'What needs doing?' : 'What should the agent do?'}</T>
        <T variant="dim">{card
          ? 'Describe the work. Add it to the backlog for the pipeline, or start an agent on it now.'
          : 'Ask about the code or describe a change. The agent works on its own branch, outside the pipeline.'}</T>
      </View>
      <View style={{ backgroundColor: p.panel, borderWidth: 1, borderColor: p.line, borderRadius: radiusLg + 2, padding: 14, gap: 12 }}>
        {card && <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Title (optional)"
          accessibilityLabel="Title"
          placeholderTextColor={p.textFaint}
          maxLength={200}
          editable={!submit.isPending}
          style={{ color: p.text, fontFamily: fonts.semibold, fontSize: 17, paddingVertical: 4 }}
        />}
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          autoFocus
          multiline
          editable={!submit.isPending}
          accessibilityLabel="Message"
          placeholder={card ? 'Add a rate limit to the public API. Which endpoints, the limits, and what to leave alone.' : 'Where does the login flow live, and why does it redirect twice?'}
          placeholderTextColor={p.textFaint}
          style={{ color: p.text, fontFamily: fonts.regular, fontSize: 16, lineHeight: 22, minHeight: 120, textAlignVertical: 'top' }}
        />
        <ErrorMessage error={submit.error} />
        {card && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Switch value={startNow} onValueChange={setStartNow} disabled={submit.isPending} trackColor={{ true: p.brand, false: p.lineBright }} accessibilityLabel="Start agent now" />
          <T variant="body">Start agent now</T>
        </View>}
        {startNow && <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Tool label="Harness" value={harness?.label ?? cli} onPress={() => setPicking('harness')} disabled={submit.isPending} />
          <Tool label="Model" value={models.find(option => option.value === model)?.name ?? (model || 'Choose')} onPress={() => { setModelSearch(''); setPicking('model'); }} disabled={submit.isPending} />
        </View>}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={startNow ? 'Start session' : 'Add card'}
          disabled={!ready}
          onPress={() => submit.mutate()}
          style={({ pressed }) => ({ alignSelf: 'flex-end', minHeight: 44, paddingHorizontal: 18, borderRadius: radius + 1, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: !ready ? 0.45 : pressed ? 0.8 : 1 })}
        >
          {submit.isPending && <ActivityIndicator size="small" color={p.onBrand} />}
          <T style={{ color: p.onBrand, fontFamily: fonts.semibold, fontSize: 15 }}>{submit.isPending ? (startNow ? 'Starting the agent…' : 'Adding the card…') : startNow ? 'Start session' : 'Add card'}</T>
        </Pressable>
      </View>
    </ScrollView>
    <Sheet visible={picking === 'harness'} onClose={() => setPicking(null)} title="Harness">
      {HARNESSES.map(option => <SheetItem key={option.value} label={option.label} selected={option.value === cli} onPress={() => { setCli(option.value); setModel(recent?.agentCli === option.value && recent.agentModel ? recent.agentModel : option.defaultModel ?? ''); setPicking(null); }} />)}
    </Sheet>
    <Sheet visible={picking === 'model'} onClose={() => setPicking(null)} title="Model">
      <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
        <Field value={modelSearch} onChangeText={setModelSearch} placeholder={models.length > 0 ? 'Search models, or type a model id' : 'Type a model id'} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Search models" />
      </View>
      {typed && !models.some(option => option.value === typed) && <SheetItem label={`Use ${typed}`} detail="A model id this harness understands" onPress={() => { setModel(typed); setPicking(null); }} />}
      {shownModels.map(option => <SheetItem key={option.value} label={option.name} detail={option.provider} selected={option.value === model} onPress={() => { setModel(option.value); setPicking(null); }} />)}
      {shownModels.length === 0 && !typed && <T variant="faint" style={{ paddingHorizontal: 20, paddingVertical: 12 }}>No model matches.</T>}
    </Sheet>
  </KeyboardAvoidingView>;
}

function Tool({ label, value, onPress, disabled }: { label: string; value: string; onPress: () => void; disabled?: boolean }) {
  const p = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} onPress={onPress} disabled={disabled} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: p.lineBright, borderRadius: radius + 1, paddingHorizontal: 10, minHeight: 36, opacity: pressed ? 0.7 : 1, maxWidth: '100%' })}>
    <T variant="faint">{label}</T>
    <T variant="body" numberOfLines={1} style={{ flexShrink: 1, fontSize: 14 }}>{value}</T>
    <DownMark />
  </Pressable>;
}
