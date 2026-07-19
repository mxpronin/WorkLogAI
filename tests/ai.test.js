import test from 'node:test';
import assert from 'node:assert/strict';

import { completeJson, transcribeAudio } from '../src/ai/client.js';
import { buildPrompt, DEFAULT_PROMPTS, parseAiResult, ROLE_PREFIX } from '../src/ai/contracts.js';
import { improveEntryDescription } from '../src/ai/improve.js';
import { isSuperficialImprovement } from '../src/ai/quality.js';

test('surface-level punctuation changes are rejected as an improvement', () => {
  assert.equal(isSuperficialImprovement('проверил обмен данными', 'Проверил обмен данными.'), true);
  assert.equal(
    isSuperficialImprovement('проверил обмен данными', 'Проведена проверка обмена данными между системами. Зафиксирован результат выполнения контрольного сценария.'),
    false,
  );
});

test('entry improvement retries when the first response only changes punctuation', async () => {
  const prompts = [];
  const responses = [
    { schemaVersion: 1, spprDescription: 'Проверил обмен данными.', warnings: [] },
    { schemaVersion: 1, spprDescription: 'Проведена проверка обмена данными между системами. Зафиксирован результат выполнения контрольного сценария.', warnings: [] },
  ];
  const result = await improveEntryDescription({
    config: {},
    editablePrompt: DEFAULT_PROMPTS.entry,
    payload: { task: { title: 'Обмен данными', description: 'Контроль интеграции' }, realNote: 'проверил обмен данными' },
    sourceText: 'проверил обмен данными',
    complete: async (_config, prompt) => {
      prompts.push(prompt);
      return JSON.stringify(responses[prompts.length - 1]);
    },
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /поверхностной корректурой/i);
  assert.equal(result.retried, true);
  assert.match(result.spprDescription, /контрольного сценария/i);
});

test('entry prompt keeps the requested lead developer role without an extra prefix', () => {
  const prompt = buildPrompt('entry', DEFAULT_PROMPTS.entry, { note: 'Исправил запрос.' });
  assert.match(prompt, /^Ты — ведущий программист 1С/);
  assert.equal(prompt.includes(ROLE_PREFIX), false);
  assert.match(prompt, /Основной вариант — 1–3 предложения/);
});

test('task-description contract returns a professional description', () => {
  const result = parseAiResult('task', JSON.stringify({ schemaVersion: 1, spprDescription: 'Подробное описание задачи.', warnings: [] }));
  assert.deepEqual(result, { spprDescription: 'Подробное описание задачи.', warnings: [] });
  const prompt = buildPrompt('task', DEFAULT_PROMPTS.task, { task: { title: 'Отчёт' } });
  assert.match(prompt, /^Ты — ведущий аналитик и постановщик задач/);
  assert.equal(prompt.includes(ROLE_PREFIX), false);
  assert.match(prompt, /## Описание/);
});

test('day prompt keeps report style and strict allocation rules', () => {
  const prompt = buildPrompt('day', DEFAULT_PROMPTS.day, { targetMinutes: 480, distributionTaskIds: ['task-1'] });
  assert.match(prompt, /1–3 содержательных предложения/);
  assert.match(prompt, /шагом 30 минут/);
  assert.match(prompt, /строго равна targetMinutes/);
  assert.match(prompt, /только идентификаторы из distributionTaskIds/);
});

test('transcription request uses the dedicated model and Russian language', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ text: 'Расшифрованный текст' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const text = await transcribeAudio(
    { baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'openai/gpt-4o-mini-transcribe', prompt: DEFAULT_PROMPTS.audio },
    new Blob(['audio'], { type: 'audio/webm' }),
  );

  assert.equal(text, 'Расшифрованный текст');
  assert.equal(request.url, 'https://example.test/v1/audio/transcriptions');
  assert.equal(request.options.body.get('model'), 'openai/gpt-4o-mini-transcribe');
  assert.equal(request.options.body.get('language'), 'ru');
  assert.equal(request.options.body.get('response_format'), 'json');
  assert.match(request.options.body.get('prompt'), /точной расшифровкой аудио/i);
});

test('GPT-5 text models use Responses API and parse raw HTTP output', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"schemaVersion":1}' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const content = await completeJson(
    { baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'openai/gpt-5.4-mini' },
    'Верни JSON',
  );

  assert.equal(content, '{"schemaVersion":1}');
  assert.equal(request.url, 'https://example.test/v1/responses');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'openai/gpt-5.4-mini', input: 'Верни JSON' });
});

test('chat-latest models keep Chat Completions compatibility', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"schemaVersion":1}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await completeJson(
    { baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'openai/gpt-5.3-chat-latest' },
    'Верни JSON',
  );

  assert.equal(request.url, 'https://example.test/v1/chat/completions');
});
