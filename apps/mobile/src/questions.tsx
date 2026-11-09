import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import type { QuestionChoice, RunQuestion } from '@bento/api-client';
import { useSession } from './session';
import { answersReady } from './model';
import { radius, usePalette } from './theme';
import { Button, ErrorMessage, Field, Panel, T } from './ui';

export function Questions({ request, onAnswered }: { request: RunQuestion; onAnswered: () => void }) {
  const { client } = useSession();
  const p = usePalette();
  const [answers, setAnswers] = useState<QuestionChoice[]>(request.questions.map(q => ({ question: q.question, selected: [] })));
  const submit = useMutation({ mutationFn: () => client.answerRunQuestion(request.runId, request.id, answers), onSuccess: onAnswered });
  function update(index: number, patch: Partial<QuestionChoice>) {
    setAnswers(current => current.map((answer, i) => i === index ? { ...answer, ...patch } : answer));
  }
  return <Panel style={{ borderColor: p.gated }}>
    <T variant="label">Your agent needs a decision</T>
    {request.questions.map((question, index) => <View key={index} style={{ gap: 8 }}>
      <T variant="body">{question.question}</T>
      {question.multiSelect && <T variant="faint">Choose all that apply.</T>}
      {question.options.map(option => {
        const chosen = answers[index].selected.includes(option.label);
        return <Pressable
          key={option.label}
          accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
          accessibilityState={{ checked: chosen, disabled: submit.isPending }}
          disabled={submit.isPending}
          onPress={() => {
            const selected = answers[index].selected;
            update(index, { ...(!question.multiSelect ? { other: '' } : {}), selected: chosen ? selected.filter(label => label !== option.label) : question.multiSelect ? [...selected, option.label] : [option.label] });
          }}
          style={{ borderWidth: 1, borderColor: chosen ? p.brand : p.lineBright, borderRadius: radius + 1, padding: 12, gap: 2, backgroundColor: p.bg }}
        >
          <T variant="label" style={chosen ? { color: p.brand } : undefined}>{option.label}</T>
          {option.description ? <T variant="faint">{option.description}</T> : null}
        </Pressable>;
      })}
      <Field
        placeholder={question.multiSelect ? 'Your answer or extra context' : 'Or write your own answer'}
        accessibilityLabel={question.multiSelect ? 'Your answer or extra context' : 'Or write your own answer'}
        value={answers[index].other ?? ''}
        onChangeText={other => update(index, { other, ...(!question.multiSelect && other.trim() ? { selected: [] } : {}) })}
        editable={!submit.isPending}
        multiline
      />
    </View>)}
    <ErrorMessage error={submit.error} />
    <Button kind="primary" title={submit.isPending ? 'Sending...' : 'Send answers'} disabled={submit.isPending || !answersReady(request, answers)} onPress={() => submit.mutate()} />
  </Panel>;
}
