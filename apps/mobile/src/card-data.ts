import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isRunActive } from './board-model';
import { useForeground, useSession } from './session';

/** Everything a card's drawer and conversation read, refreshed by the board's event stream. */
export function useCard(featureId: string) {
  const { client } = useSession();
  const active = useForeground();
  const query = useQuery({
    queryKey: ['card', featureId],
    queryFn: async () => {
      const [card, conversation] = await Promise.all([client.getFeature(featureId), client.getConversation(featureId)]);
      const live = card.runs.filter(run => isRunActive(run.status));
      const questions = (await Promise.all(live.map(run => client.listRunQuestions(run.id)))).flat();
      return { card, conversation, questions };
    },
    // Questions are not a stream event, so they are polled while the card is open.
    refetchInterval: active ? 10_000 : false,
  });
  const projectId = query.data?.card.projectId;
  useEffect(() => {
    if (!active || !projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void query.refetch(); }, 300); };
    const stop = client.streamBoard(projectId, refresh, refresh);
    return () => { stop(); clearTimeout(timer); };
  }, [active, client, projectId]);
  return query;
}

export function useProfiles() {
  const { client } = useSession();
  return useQuery({ queryKey: ['profiles'], queryFn: () => client.listProfiles(), staleTime: 60_000 });
}

export function usePipeline(projectId: string | undefined) {
  const { client } = useSession();
  return useQuery({ queryKey: ['pipeline', projectId], queryFn: () => client.getPipeline(projectId!), enabled: Boolean(projectId), staleTime: 60_000 });
}
