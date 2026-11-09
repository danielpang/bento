import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@bento/core';
import { useForeground, useSession } from './session';
import { mergeEvent } from './model';

/**
 * A running run's events from its stream. The stream closes in the
 * background and resumes from the last sequence it delivered.
 */
export function useLiveRun(runId: string | null, onDone: () => void) {
  const { client } = useSession();
  const active = useForeground();
  const cursor = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  const [events, setEvents] = useState<{ seq: number; event: AgentEvent }[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    cursor.current = 0;
    setEvents([]);
  }, [runId]);
  useEffect(() => {
    if (!active || !runId) return;
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
  return { events: events.map(item => item.event), draft, error, following: active };
}
