import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { AgentEvent } from '@bento/core';
import { useForeground, useSession } from './session';
import { eventText, mergeEvent } from './model';
import { ErrorMessage, styles } from './ui';

export function LiveTranscript({ runId, onDone }: { runId: string; onDone: () => void }) {
  const { client } = useSession();
  const active = useForeground();
  const cursor = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  const [events, setEvents] = useState<{ seq: number; event: AgentEvent }[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!active) return;
    setDraft(''); setError(undefined);
    return client.streamRun(runId, {
      onEvent: (event, seq) => {
        cursor.current = Math.max(cursor.current, seq);
        setEvents(previous => mergeEvent(previous, seq, event).slice(-500));
        if (event.type === 'message' || event.type === 'result') setDraft('');
      },
      onDelta: delta => {
        if (delta.channel === 'text') setDraft(previous => delta.offset === 0 ? delta.text : delta.offset === previous.length ? previous + delta.text : previous);
      },
      onError: setError,
      onDone: () => { setDraft(''); done.current(); },
    }, cursor.current);
  }, [client, runId, active]);
  return <View style={{ gap: 12 }}><Text style={styles.heading}>Live conversation</Text>
    <Text style={styles.muted}>{active ? 'Updates while this screen is open.' : 'Updates resume when you return.'} Showing up to 500 recent events.</Text>
    <ErrorMessage error={error} />
    {events.map(({ seq, event }) => <View key={seq} style={styles.card}><Text style={styles.muted}>{event.type === 'message' ? event.role : 'Activity'}</Text><Text selectable style={styles.text}>{eventText(event)}</Text></View>)}
    {draft ? <Text selectable style={styles.text}>{draft}</Text> : null}
    {!events.length && !error && <Text style={styles.muted}>Waiting for the agent…</Text>}
  </View>;
}
