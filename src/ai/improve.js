import { completeJson } from './client.js';
import { buildPrompt, parseAiResult } from './contracts.js';
import { isSuperficialImprovement } from './quality.js';

export async function improveEntryDescription({ config, editablePrompt, payload, sourceText, complete = completeJson }) {
  let response = await complete(config, buildPrompt('entry', editablePrompt, payload));
  let result = parseAiResult('entry', response);
  let retried = false;

  if (isSuperficialImprovement(sourceText, result.spprDescription)) {
    retried = true;
    const retryPrompt = `${editablePrompt}\n\nПредыдущий вариант оказался поверхностной корректурой. Перепиши описание заново и содержательно: используй факты исходной заметки и контекст задачи, сформулируй выполненные действия и результат, но ничего не выдумывай.`;
    response = await complete(config, buildPrompt('entry', retryPrompt, { ...payload, rejectedDraft: result.spprDescription }));
    result = parseAiResult('entry', response);
  }

  return { ...result, retried };
}
