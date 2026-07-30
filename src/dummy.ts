import { CORPUS } from './dummy-corpus';

const params = new URLSearchParams(location.search);

const MAX_BLOCKS = 200;
const MAX_DEPTH = 5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const countEl = document.getElementById('dummy-count') as HTMLInputElement;
const depthEl = document.getElementById('dummy-depth') as HTMLSelectElement;
const outputEl = document.getElementById('dummy-output') as HTMLTextAreaElement;
const shuffleEl = document.getElementById('dummy-shuffle')!;
const copyEl = document.getElementById('dummy-copy')!;

countEl.value = String(clamp(Number(params.get('blocks')) || 12, 1, MAX_BLOCKS));
depthEl.value = String(clamp(Number(params.get('depth') ?? 2), 0, MAX_DEPTH));

// Draws from a reshuffled bag rather than picking independently at random,
// so a generated outline doesn't repeat a sentence until the whole corpus
// has been used — near-duplicate rows make it far harder to tell whether an
// outliner rendered the tree correctly.
let bag: string[] = [];

function nextSentence(): string {
  if (bag.length === 0) {
    bag = CORPUS.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }
  return bag.pop()!;
}

// Walks a level up or down by at most one step per block: an outline where a
// row jumps two levels deeper than its predecessor has no valid parent, and
// most outliners will either reject it or silently flatten it — not the
// input you want to be testing against.
function generate(count: number, maxDepth: number): string {
  const lines: string[] = [];
  let level = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      const roll = Math.random();
      if (roll < 0.35 && level < maxDepth) level += 1;
      else if (roll < 0.55 && level > 0) level -= 1;
    }
    lines.push(`${'  '.repeat(level)}- ${nextSentence()}`);
  }
  return lines.join('\n');
}

function render() {
  const count = clamp(Number(countEl.value) || 1, 1, MAX_BLOCKS);
  const depth = clamp(Number(depthEl.value), 0, MAX_DEPTH);
  outputEl.value = generate(count, depth);
  outputEl.scrollTop = 0;
}

let copyResetId: number | undefined;

// The async Clipboard API is the happy path, but this page runs as a
// cross-origin iframe inside someone else's app, where a Permissions-Policy
// that omits `clipboard-write` will reject the promise. The deprecated
// execCommand path isn't gated that way, so it's kept as the fallback — and
// if both fail, select the text so a manual Cmd-C still works.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    outputEl.select();
    try {
      if (document.execCommand('copy')) return true;
    } catch {
      // Fall through to leaving the text selected.
    }
    return false;
  }
}

copyEl.addEventListener('click', async () => {
  const ok = await copyToClipboard(outputEl.value);
  copyEl.textContent = ok ? 'Copied' : 'Press ⌘C';
  if (copyResetId !== undefined) clearTimeout(copyResetId);
  copyResetId = window.setTimeout(() => {
    copyEl.textContent = 'Copy';
  }, 1500);
});

shuffleEl.addEventListener('click', render);
countEl.addEventListener('change', render);
depthEl.addEventListener('change', render);

render();

export {};
