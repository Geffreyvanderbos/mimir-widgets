import { headword, lookup } from './very-lookup';
import { ENTRIES, type Entry } from './very-words';

const params = new URLSearchParams(location.search);

const inputEl = document.getElementById('very-input') as HTMLInputElement;
const resultsEl = document.getElementById('very-results')!;
const footEl = document.getElementById('very-foot')!;

const DEFAULT_FOOT = `${ENTRIES.length} entries · tap a word to copy it`;
/** Shown when nothing at all matched — three headwords worth trying. */
const NUDGE = ['tired', 'expensive', 'angry'];

// Same three-step fallback as the color widget: the async Clipboard API can be
// withheld from a cross-origin iframe by the consumer's Permissions-Policy,
// execCommand isn't gated that way, and if both fail the text is left selected
// so a manual ⌘C still works.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.className = 'very-scratch';
    document.body.append(scratch);
    scratch.select();
    try {
      if (document.execCommand('copy')) return true;
    } catch {
      // Fall through to leaving the text selected.
    } finally {
      setTimeout(() => scratch.remove(), 0);
    }
    return false;
  }
}

let footResetId: number | undefined;

function flashFoot(message: string) {
  footEl.textContent = message;
  if (footResetId !== undefined) clearTimeout(footResetId);
  footResetId = window.setTimeout(() => {
    footEl.textContent = DEFAULT_FOOT;
  }, 1600);
}

/** Every button currently in the results region, in visual order. */
let focusables: HTMLButtonElement[] = [];

function wordButton(word: string, primary: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'very-word is-primary' : 'very-word';
  button.textContent = word;
  button.addEventListener('click', async () => {
    const copied = await copyToClipboard(word);
    flashFoot(copied ? `Copied “${word}”` : `Select and press ⌘C to copy “${word}”`);
  });
  return button;
}

function suggestionButton(entry: Entry): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'very-suggest';

  const word = document.createElement('span');
  word.textContent = `very ${entry.word}`;
  button.append(word);

  if (entry.sense !== undefined) {
    const sense = document.createElement('span');
    sense.className = 'very-sense-inline';
    sense.textContent = entry.sense;
    button.append(sense);
  }

  button.addEventListener('click', () => {
    inputEl.value = entry.word;
    render();
    inputEl.focus();
  });
  return button;
}

function renderHits(hits: Entry[]) {
  for (const entry of hits) {
    const group = document.createElement('div');
    group.className = 'very-hit';

    if (entry.sense !== undefined) {
      const sense = document.createElement('p');
      sense.className = 'very-sense';
      sense.textContent = entry.sense;
      group.append(sense);
    }

    const [best, ...rest] = entry.alts;
    group.append(wordButton(best, true));

    if (rest.length > 0) {
      const row = document.createElement('div');
      row.className = 'very-alts';
      for (const alt of rest) row.append(wordButton(alt, false));
      group.append(row);
    }

    resultsEl.append(group);
  }
}

function renderSuggestions(key: string, suggestions: Entry[]) {
  const message = document.createElement('p');
  message.className = 'very-message';
  message.textContent =
    suggestions.length > 0 ? `No entry for “${key}”. Did you mean:` : `No entry for “${key}”. Try:`;
  resultsEl.append(message);

  const list = document.createElement('div');
  list.className = 'very-suggests';
  const shown =
    suggestions.length > 0
      ? suggestions
      : NUDGE.flatMap((word) => ENTRIES.filter((entry) => entry.word === word).slice(0, 1));
  for (const entry of shown) list.append(suggestionButton(entry));
  resultsEl.append(list);
}

function render() {
  const { key, hits, suggestions } = lookup(inputEl.value);
  resultsEl.replaceChildren();

  if (key === '') {
    const message = document.createElement('p');
    message.className = 'very-message';
    message.textContent = 'Type an adjective you keep saying “very” in front of.';
    resultsEl.append(message);
  } else if (hits.length > 0) {
    renderHits(hits);
  } else {
    renderSuggestions(key, suggestions);
  }

  resultsEl.scrollTop = 0;
  focusables = [...resultsEl.querySelectorAll('button')] as HTMLButtonElement[];
}

function moveFocus(delta: number) {
  if (focusables.length === 0) return;
  const current = focusables.indexOf(document.activeElement as HTMLButtonElement);
  const next = current === -1 ? (delta > 0 ? 0 : focusables.length - 1) : current + delta;
  if (next < 0) {
    inputEl.focus();
    inputEl.select();
    return;
  }
  focusables[Math.min(next, focusables.length - 1)].focus();
}

inputEl.addEventListener('input', render);
inputEl.addEventListener('focus', () => inputEl.select());

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(-1);
  } else if (event.key === 'Escape') {
    inputEl.focus();
    inputEl.select();
  } else if (event.key === 'Enter' && document.activeElement === inputEl) {
    // The field has nothing to submit — results are already live — so Enter
    // dismisses a phone keyboard instead of reloading the frame.
    event.preventDefault();
    inputEl.blur();
  }
});

// An empty card reads as broken in a note, so a widget embedded without ?w=
// opens on a real entry rather than a blank field (§6). Deliberately a fixed
// word and not a random one: the iframe is destroyed and recreated on every
// visit to the note (§7), so a random pick would show a different word each
// time the same person came back, and a different one again to everyone else
// reading the same note.
const DEFAULT_WORD = 'tired';

// `very` is drawn beside the field, not inside it, so the parameter is peeled
// of its own intensifier before it lands there — ?w=really+tired asks a real
// question, and would otherwise render as "very really tired".
inputEl.value = headword(params.get('w') ?? '') || DEFAULT_WORD;
footEl.textContent = DEFAULT_FOOT;
render();

export {};
