function endpoint(baseUrl, path) { return `${String(baseUrl).replace(/\/+$/, '')}${path}`; }

async function request(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Сервис ИИ вернул ошибку ${response.status}.`);
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Сервис ИИ не ответил за ${Math.round(timeoutMs / 1000)} секунд.`);
    throw error instanceof Error ? error : new Error('Не удалось обратиться к сервису ИИ.');
  } finally { clearTimeout(timer); }
}

export async function completeJson(config, prompt) {
  const useResponsesApi = /(?:^|\/)gpt-5(?:[.-]|$)/i.test(config.model) && !/chat-latest$/i.test(config.model);
  const path = useResponsesApi ? '/responses' : '/chat/completions';
  const payload = useResponsesApi
    ? { model: config.model, input: prompt }
    : { model: config.model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] };
  const response = await request(endpoint(config.baseUrl, path), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  const outputContent = Array.isArray(body?.output)
    ? body.output.flatMap((item) => Array.isArray(item?.content) ? item.content : []).find((item) => item?.type === 'output_text')?.text
    : undefined;
  const content = useResponsesApi ? body?.output_text ?? outputContent : body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Сервис ИИ вернул пустой ответ.');
  return content;
}

export async function transcribeAudio(config, audio, filename = 'worklog-audio.webm') {
  const form = new FormData();
  form.append('model', config.model);
  form.append('file', audio, filename);
  form.append('language', 'ru');
  form.append('response_format', 'json');
  if (config.prompt) form.append('prompt', String(config.prompt).slice(0, 1000));
  const response = await request(endpoint(config.baseUrl, '/audio/transcriptions'), {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form,
  }, 120000);
  const body = await response.json();
  if (typeof body?.text !== 'string' || !body.text.trim()) throw new Error('Сервис расшифровки не вернул текст.');
  return body.text.trim();
}
