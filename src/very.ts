import { copyToClipboard } from './clipboard';
import { headword, lookup, sampleWord } from './very-lookup';
import { ENTRIES, type Entry } from './very-words';

const params = new URLSearchParams(location.search);

const inputEl = document.getElementById('very-input') as HTMLInputElement;
const resultsEl = document.getElementById('very-results')!;
const footEl = document.getElementById('very-foot')!;
const shuffleEl = document.getElementById('very-shuffle') as HTMLButtonElement;

const DEFAULT_FOOT = `${ENTRIES.length} entries · tap a word to copy it`;
/** Shown when nothing at all matched — three headwords worth trying. */
const NUDGE = ['tired', 'expensive', 'angry'];

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
    message.textContent =
      'Type an adjective you keep saying “very” in front of — or shuffle for one.';
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

function shuffle() {
  inputEl.value = sampleWord(Math.random(), headword(inputEl.value));
  render();
}

// Focus deliberately stays on the button rather than moving to the field: this
// is the one control meant to be pressed repeatedly, and on a phone focusing
// the input would throw the keyboard over the card between every word.
shuffleEl.addEventListener('click', shuffle);

// A widget embedded without ?w= deals a word at random on every load, so a
// paramless embed is a word to learn rather than a blank field (§6). That the
// frame is rebuilt on each visit (§7) is the *point* here — a URL carrying no
// word never promised to show a particular one. A URL that does carry ?w= is
// still stable, and the shuffle overrides it in memory only, never writing
// back to the address bar.
//
// The parameter is peeled of its own intensifier before it lands in the field,
// since `very` is drawn beside the field rather than inside it: ?w=really+tired
// asks a real question, and would otherwise render as "very really tired".
inputEl.value = headword(params.get('w') ?? '') || sampleWord(Math.random());
footEl.textContent = DEFAULT_FOOT;
render();

export {};
