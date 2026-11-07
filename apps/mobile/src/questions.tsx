import { useState } from 'react';
import { Text, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import type { QuestionChoice, RunQuestion } from '@bento/api-client';
import { useSession } from './session';
import { answersReady } from './model';
import { Button, ErrorMessage, Input, styles } from './ui';
export function Questions({ request, onAnswered }: { request: RunQuestion; onAnswered: () => void }) {
  const { client } = useSession();
  const [answers, setAnswers] = useState<QuestionChoice[]>(request.questions.map(q => ({ question: q.question, selected: [] })));
  const submit = useMutation({ mutationFn: () => client.answerRunQuestion(request.runId, request.id, answers), onSuccess: onAnswered });
  function update(index: number, patch: Partial<QuestionChoice>) {
    setAnswers(current => current.map((answer, i) => i === index ? { ...answer, ...patch } : answer));
  }
  return <View style={styles.card}><Text style={styles.heading}>Your agent needs a decision</Text>
    {request.questions.map((question, index) => <View key={index} style={{ gap: 10 }}>
      <Text style={styles.text}>{question.question}</Text>
      {question.multiSelect && <Text style={styles.muted}>Choose all that apply.</Text>}
      {question.options.map(option => <View key={option.label} style={{ gap: 5 }}>
        <Button title={`${answers[index].selected.includes(option.label) ? '✓ ' : ''}${option.label}`} secondary={!answers[index].selected.includes(option.label)} disabled={submit.isPending} onPress={() => {
          const selected = answers[index].selected;
          update(index, { ...(!question.multiSelect ? { other: '' } : {}), selected: selected.includes(option.label) ? selected.filter(label => label !== option.label) : question.multiSelect ? [...selected, option.label] : [option.label] });
        }} />
        {option.description && <Text style={styles.muted}>{option.description}</Text>}
      </View>)}
      <Input label={question.multiSelect ? 'Your answer or extra context' : 'Or write your own answer'} value={answers[index].other ?? ''} onChangeText={other => update(index, { other, ...(!question.multiSelect && other.trim() ? { selected: [] } : {}) })} editable={!submit.isPending} multiline />
    </View>)}
    <ErrorMessage error={submit.error} />
    <Button title={submit.isPending ? 'Sending…' : 'Send answers'} disabled={submit.isPending || !answersReady(request, answers)} onPress={() => submit.mutate()} />
  </View>;
}
