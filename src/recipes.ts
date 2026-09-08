/*
 * The builder for /recipe URLs. One click on "Build recipe table" does two
 * fetches in sequence, and only the second one leaves this browser: first
 * /api/recipe (recipe.ts's schema.org extraction — most recipe pages send no
 * CORS header, so this browser can't fetch them itself), then the extracted
 * ingredients/instructions as plain text to whatever LLM endpoint step 1
 * configured (localStorage-only, recipe-llm.ts), asking for the merge-tree
 * JSON that recipe-codec.ts's buildLayout turns into a table. The extraction
 * result is kept around after that so "Regenerate" can re-ask the model
 * without re-fetching the page.
 */

import { copyToClipboard } from './clipboard';
import { buildLayout, encodeRecipe, type RecipeData, type RecipeStep } from './recipe-codec';
import { renderTableHtml } from './recipe-render';
import { askForJson, loadLlmConfig, saveLlmConfig, LlmError } from './recipe-llm';

interface Extracted {
  title: string;
  ingredients: string[];
  instructions: string[];
  servings?: string;
  totalMinutes?: number;
  sourceUrl: string;
}

const URL_LENGTH_WARNING = 1600;

const urlEl = document.getElementById('recipe-llm-url') as HTMLInputElement;
const modelEl = document.getElementById('recipe-llm-model') as HTMLInputElement;
const keyEl = document.getElementById('recipe-llm-key') as HTMLInputElement;

const recipeUrlEl = document.getElementById('recipe-url') as HTMLInputElement;
const buildButtonEl = document.getElementById('recipe-build') as HTMLButtonElement;
const progressEl = document.getElementById('recipe-progress')!;
const statusEl = document.getElementById('recipe-status')!;

const resultStepEl = document.getElementById('recipe-result-step')!;
const previewTitleEl = document.getElementById('recipe-preview-title')!;
const previewMetaEl = document.getElementById('recipe-preview-meta')!;
const previewTableEl = document.getElementById('recipe-preview-table')!;
const resultUrlEl = document.getElementById('recipe-result-url') as HTMLTextAreaElement;
const resultLengthEl = document.getElementById('recipe-result-length')!;
const copyButtonEl = document.getElementById('recipe-copy') as HTMLButtonElement;
const openEl = document.getElementById('recipe-open') as HTMLAnchorElement;
const regenerateButtonEl = document.getElementById('recipe-regenerate') as HTMLButtonElement;

let extracted: Extracted | null = null;

function setStatus(el: HTMLElement, text: string, isError: boolean): void {
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}

function saveConfig(): void {
  saveLlmConfig({ baseUrl: urlEl.value, apiKey: keyEl.value, model: modelEl.value });
}
{
  const config = loadLlmConfig();
  urlEl.value = config.baseUrl;
  modelEl.value = config.model;
  keyEl.value = config.apiKey;
}
for (const el of [urlEl, modelEl, keyEl]) el.addEventListener('input', saveConfig);

async function fetchExtracted(target: string): Promise<Extracted | null> {
  try {
    const response = await fetch(`/api/recipe?url=${encodeURIComponent(target)}`);
    const body = (await response.json().catch(() => null)) as
      | (Extracted & { error?: string })
      | { error: string }
      | null;

    if (!response.ok || body === null || 'error' in body) {
      setStatus(statusEl, body?.error ?? `Extraction failed (${response.status}).`, true);
      return null;
    }
    return body;
  } catch {
    setStatus(statusEl, 'Something went wrong reaching this site.', true);
    return null;
  }
}

// Recipe sites are consistent enough about units (cups/tbsp/tsp/oz/lb/°F,
// almost always) that asking the model to normalize them is a reliable
// transformation rather than a guess — worth doing automatically rather
// than adding a unit-system toggle for something this predictable.
const SYSTEM_PROMPT = `You convert a recipe's ingredients and instructions into a "recipe table" — the cookingforengineers.com format. Every ingredient is a leaf; every cooking step is a node that merges some already-made things (ingredients and/or earlier steps' results) into one new thing; the last step's result is the finished dish, used by nothing further.

Output ONLY a JSON object of exactly this shape, no other text, no markdown fences:
{"p": ["prep step", ...], "i": ["ingredient text", ...], "s": [{"u": [ids], "a": "what this step does"}, ...]}

Node ids: ingredient k (its 0-indexed position in "i") has id k. Step k's result has id i.length + k. A step's "u" lists the ids it combines. Every id must come from something already made (an ingredient, or an earlier step in "s"), and every id must be consumed by exactly one later step, except the final step's result.

"p" is for prep steps that don't belong to any single ingredient and shouldn't be forced into the merge chain — preheating the oven, lining a pan, toasting a spice blend. They're drawn as their own rows above the table. Omit "p", or use an empty array, if the recipe has none.

Rules:
- Keep the merge chain shallow, at most about 5 levels deep: fold several sequential actions on the same thing into one step's "a" (e.g. one step "melt butter, then cool slightly" rather than two steps).
- Every entry in "i" must be consumed by exactly one step.
- Word each "a" as a short imperative phrase.
- Keep ingredient text to a glance-length quantity + name (e.g. "250 g flour").
- Convert US customary quantities and temperatures to metric — cups, tablespoons, teaspoons, ounces, pounds and Fahrenheit all become grams, millilitres or Celsius. Round to a sensible cooking precision (nearest 5 g/mL, nearest 5°C) rather than false precision, and leave a recipe that's already metric as given.
- Put oven/pan/equipment setup and anything else that isn't really "about" one ingredient into "p" rather than stretching a step's "a" to cover it.

Worked example — 2 cups flour, 1 cup water and 1 teaspoon salt becoming dough, floured surface prepped first (note the metric conversion and the prep row):
{"p":["Flour a work surface"],"i":["250 g flour","240 mL water","5 g salt"],"s":[{"u":[0,2],"a":"mix dry"},{"u":[3,1],"a":"knead into dough"}]}`;

function buildUserPrompt(source: Extracted): string {
  return [
    `Recipe: ${source.title}`,
    '',
    'Ingredients:',
    ...source.ingredients.map((line) => `- ${line}`),
    '',
    'Instructions:',
    ...source.instructions.map((line, index) => `${index + 1}. ${line}`),
  ].join('\n');
}

interface StepGraph {
  p?: string[];
  i: string[];
  s: RecipeStep[];
}

function validateStepGraph(value: unknown): asserts value is StepGraph {
  if (typeof value !== 'object' || value === null) throw new Error('response is not a JSON object');
  const record = value as Record<string, unknown>;
  if (record.p !== undefined && (!Array.isArray(record.p) || !record.p.every((x) => typeof x === 'string'))) {
    throw new Error('"p" must be an array of strings if present');
  }
  if (!Array.isArray(record.i) || record.i.length === 0 || !record.i.every((x) => typeof x === 'string')) {
    throw new Error('"i" must be a non-empty array of strings');
  }
  if (!Array.isArray(record.s) || record.s.length === 0) {
    throw new Error('"s" must be a non-empty array of steps');
  }
  for (const step of record.s) {
    if (
      typeof step !== 'object' ||
      step === null ||
      !Array.isArray((step as Record<string, unknown>).u) ||
      typeof (step as Record<string, unknown>).a !== 'string'
    ) {
      throw new Error('each step needs a "u" array of ids and an "a" string');
    }
  }
  // Full structural check — contiguity, convergence to one root, no
  // double-consumed or dangling ids — reusing the exact validator the
  // widget itself trusts.
  buildLayout({ t: '', i: record.i as string[], s: record.s as RecipeStep[] });
}

async function buildResultUrl(data: RecipeData): Promise<void> {
  const layout = buildLayout(data);
  previewTitleEl.textContent = data.t;
  previewMetaEl.textContent = [data.n ? `serves ${data.n}` : '', data.m ? `${data.m} min` : ''].filter(Boolean).join('  ·  ');
  previewTableEl.innerHTML = renderTableHtml(layout, data.p);

  const payload = await encodeRecipe(data);
  const target = new URL('/recipe', location.origin);
  target.searchParams.set('r', payload);
  target.searchParams.set('label', data.t);
  // Row count, not ingredient count: prep rows render above the merge
  // table, and oembed.ts's height formula has to account for every row it
  // actually draws.
  target.searchParams.set('n', String(data.i.length + (data.p?.length ?? 0)));

  const href = target.toString();
  resultUrlEl.value = href;
  openEl.href = href;

  resultLengthEl.textContent = `${href.length} characters`;
  resultLengthEl.classList.toggle('is-warning', href.length > URL_LENGTH_WARNING);

  resultStepEl.hidden = false;
}

/*
 * A local model can genuinely sit there for tens of seconds on one attempt,
 * with no token stream to show real progress from (recipe-llm.ts deliberately
 * doesn't stream — see its comment). Three things carry the "still going"
 * signal, layered so nothing about it is a single static sentence:
 *
 * - The elapsed-seconds count in every render is never fake — it's the one
 *   thing that keeps changing even mid-attempt with nothing new to report.
 * - askForJson's onProgress calls are real events (which attempt is live),
 *   and always interrupt and restart the rotation below.
 * - Between those real events, a rotation through plausible-sounding phases
 *   of the actual pipeline (reading ingredients, building the merge tree,
 *   laying it out into columns) fills the gap — invented, since there's no
 *   way to observe an LLM's actual progress mid-reply, but not misleading:
 *   it names real stages of what this feature does, just not necessarily in
 *   the order or pace shown.
 */
const FILLER_PHASES = [
  'Reading through the ingredient list…',
  'Working out what combines with what…',
  'Separating out the prep steps…',
  'Converting to metric…',
  'Laying the steps out into columns…',
  'Shortening each step down to a phrase…',
  'Checking that everything converges…',
  'Still working — some models take a while here…',
];
// Slow enough that the line reads as steady progress rather than a nervous
// tic — a phrase change every few breaths, not every glance.
const FILLER_INTERVAL_MS = 5500;

function startProgress(
  statusEl: HTMLElement,
  barEl: HTMLElement,
): { setPhase: (text: string) => void; stop: () => void } {
  const start = Date.now();
  let phase = 'Waiting on the model…';
  let fillerIndex = 0;
  let fillerId: number | undefined;

  const render = () => setStatus(statusEl, `${phase} (${Math.round((Date.now() - start) / 1000)}s)`, false);

  function restartFillerRotation(): void {
    if (fillerId !== undefined) clearInterval(fillerId);
    fillerIndex = 0;
    fillerId = window.setInterval(() => {
      phase = FILLER_PHASES[fillerIndex % FILLER_PHASES.length];
      fillerIndex++;
      render();
    }, FILLER_INTERVAL_MS);
  }

  barEl.hidden = false;
  render();
  const tickId = window.setInterval(render, 1000);
  restartFillerRotation();

  return {
    setPhase: (text: string) => {
      phase = text;
      render();
      restartFillerRotation();
    },
    stop: () => {
      clearInterval(tickId);
      if (fillerId !== undefined) clearInterval(fillerId);
      barEl.hidden = true;
    },
  };
}

async function generateFromExtracted(source: Extracted): Promise<void> {
  const config = loadLlmConfig();
  if (config.baseUrl.trim() === '') {
    setStatus(statusEl, 'Set up an LLM endpoint in step 1 first.', true);
    return;
  }

  resultStepEl.hidden = true;
  const progress = startProgress(statusEl, progressEl);

  try {
    const value = await askForJson(config, SYSTEM_PROMPT, buildUserPrompt(source), validateStepGraph, progress.setPhase);
    progress.stop();
    const graph = value as StepGraph;

    const data: RecipeData = {
      t: source.title,
      p: graph.p,
      i: graph.i,
      s: graph.s,
      n: source.servings,
      m: source.totalMinutes,
      src: source.sourceUrl,
    };

    await buildResultUrl(data);
    setStatus(statusEl, 'Done.', false);
  } catch (error) {
    progress.stop();
    setStatus(statusEl, error instanceof LlmError ? error.message : 'Something went wrong generating the table.', true);
  }
}

async function build(): Promise<void> {
  const target = recipeUrlEl.value.trim();
  if (target === '') {
    setStatus(statusEl, 'Paste a recipe URL first.', true);
    return;
  }

  resultStepEl.hidden = true;
  extracted = null;
  buildButtonEl.disabled = true;
  setStatus(statusEl, 'Fetching…', false);

  try {
    const found = await fetchExtracted(target);
    if (found === null) return;
    extracted = found;
    await generateFromExtracted(found);
  } finally {
    buildButtonEl.disabled = false;
  }
}

async function regenerate(): Promise<void> {
  if (extracted === null) return;
  regenerateButtonEl.disabled = true;
  try {
    await generateFromExtracted(extracted);
  } finally {
    regenerateButtonEl.disabled = false;
  }
}

buildButtonEl.addEventListener('click', () => void build());
recipeUrlEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void build();
});
regenerateButtonEl.addEventListener('click', () => void regenerate());

let copyResetId: number | undefined;
copyButtonEl.addEventListener('click', async () => {
  const copied = await copyToClipboard(resultUrlEl.value);
  copyButtonEl.textContent = copied ? 'Copied' : 'Press ⌘C';
  if (!copied) resultUrlEl.select();
  if (copyResetId !== undefined) clearTimeout(copyResetId);
  copyResetId = window.setTimeout(() => {
    copyButtonEl.textContent = 'Copy URL';
  }, 1500);
});

export {};
