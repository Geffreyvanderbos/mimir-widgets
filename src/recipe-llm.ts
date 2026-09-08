/*
 * The client for the user's own OpenAI-compatible endpoint — local (Ollama,
 * LM Studio, llama.cpp's server) or hosted. The connection details (and any
 * API key) live only in this browser's localStorage and are sent only to
 * the endpoint the user typed, never to this site's own server: same shape
 * as the NS train key and the image-host upload token, and for the same
 * reason (see CLAUDE.md) — a key this page's author has no business seeing.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = 'mimir-widgets:recipe-llm-config';

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { baseUrl: '', apiKey: '', model: '' };
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    };
  } catch {
    return { baseUrl: '', apiKey: '', model: '' };
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// People paste any of "http://host:port", ".../v1", or the full
// ".../v1/chat/completions" — normalize down to the one shape this always
// appends "/chat/completions" to.
function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

export class LlmError extends Error {}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(config: LlmConfig, messages: ChatMessage[]): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl);
  if (base === '') {
    throw new LlmError('Set up the LLM endpoint first.');
  }

  let response: Response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey.trim() !== '' ? { authorization: `Bearer ${config.apiKey.trim()}` } : {}),
      },
      // No response_format: plenty of local OpenAI-compatible servers 400 on
      // a field they don't recognise. The prompt does the asking instead.
      body: JSON.stringify({ model: config.model.trim() || undefined, temperature: 0.2, messages }),
    });
  } catch {
    // The single most likely failure, named specifically rather than left as
    // "fetch failed": an https page can reach http://localhost, but a LAN IP
    // is blocked as mixed content, and Ollama sends no CORS header at all
    // unless OLLAMA_ORIGINS is set.
    throw new LlmError(
      "Couldn't reach that endpoint. A local http:// address on a different device than localhost is blocked as mixed content by the browser, and most local servers need CORS enabled for this page's origin (Ollama: set OLLAMA_ORIGINS).",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new LlmError('That API key was rejected.');
  }
  if (!response.ok) {
    throw new LlmError(`The LLM endpoint returned ${response.status}.`);
  }

  const body = (await response.json().catch(() => null)) as
    | { choices?: { message?: { content?: string } }[] }
    | null;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError('The LLM endpoint returned no content.');
  }
  return content;
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new SyntaxError('no JSON object found in the reply');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

const MAX_ATTEMPTS = 3;

/**
 * Sends the prompt, parses the reply as JSON, and runs `validate` against
 * it (throw to reject). On either a parse failure or a validation failure,
 * the specific error is fed back to the model and it gets another try —
 * local models in particular sometimes wrap JSON in prose, or produce a
 * step graph that doesn't converge, despite being told the exact shape.
 *
 * `onProgress`, if given, is told which attempt is in flight — real
 * information (a local model can genuinely take a retry or two), not a
 * spinner standing in for one. The caller pairs it with its own elapsed-time
 * readout, since even a single attempt can run long enough that "still on
 * attempt 1" alone wouldn't tell someone the page hasn't hung.
 */
export async function askForJson(
  config: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
  validate: (value: unknown) => void,
  onProgress?: (message: string) => void,
): Promise<unknown> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let lastError = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      onProgress?.(`That reply wasn't usable (${lastError}) — asking the model to fix it (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
      messages.push({
        role: 'user',
        content: `That was invalid: ${lastError}. Reply with ONLY a corrected JSON object, no other text.`,
      });
    } else {
      onProgress?.(`Waiting on the model (attempt 1 of ${MAX_ATTEMPTS})`);
    }
    const reply = await chat(config, messages);
    messages.push({ role: 'assistant', content: reply });
    try {
      const value = extractJson(reply);
      validate(value);
      return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'invalid response';
    }
  }
  throw new LlmError(`The model couldn't produce a usable recipe table (${lastError}).`);
}
