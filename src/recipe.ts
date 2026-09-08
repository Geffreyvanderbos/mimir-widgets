import { applyRecipeParams, decodeRecipe, encodeRecipe, type RecipeData, type RecipeLayout } from './recipe-codec';
import { formatRecipeMeta, renderTableHtml } from './recipe-render';

const params = new URLSearchParams(location.search);
const titleEl = document.getElementById('recipe-title')!;
const metaEl = document.getElementById('recipe-meta')!;
const tableWrapEl = document.getElementById('recipe-table-wrap')!;
const sourceEl = document.getElementById('recipe-source') as HTMLAnchorElement;
const editHintEl = document.getElementById('recipe-edit-hint')!;

function fail(message: string): void {
  titleEl.textContent = 'Recipe';
  metaEl.textContent = '';
  tableWrapEl.textContent = message;
  tableWrapEl.classList.add('is-empty');
  sourceEl.hidden = true;
}

// An embedded iframe (Mimir's or anyone else's) has no channel to write an
// edit back into whatever document framed it, so editing only makes sense
// unframed. Reading .self/.top never throws, even cross-origin — that's
// what makes this the standard "am I framed" check in the first place.
function isEmbedded(): boolean {
  return window.self !== window.top;
}

const SAVE_DEBOUNCE_MS = 800;

function enableEditing(data: RecipeData, layout: RecipeLayout): void {
  editHintEl.hidden = false;

  let saveTimer: number | undefined;
  function scheduleSave(): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void persist(), SAVE_DEBOUNCE_MS);
  }

  async function persist(): Promise<void> {
    try {
      // `layout` is still valid here — a plain-text edit changes what a
      // node says, never the tree's shape, so there's nothing to recompute.
      const payload = await encodeRecipe(data, layout);
      const url = new URL(location.href);
      applyRecipeParams(url, data, payload);
      history.replaceState(null, '', url);
    } catch {
      // compress() or replaceState() can genuinely fail; better to leave
      // the address bar as it was than write a broken URL into it.
    }
  }

  // contenteditable's default paste brings in whatever formatting the
  // clipboard carries; forcing plain text keeps a cell's content exactly
  // what buildLayout/renderTableHtml expect. Enter commits (blurs) rather
  // than inserting a newline — there's nowhere sensible for a second line
  // to go inside a table cell.
  function makeEditable(el: HTMLElement, onEdit: (text: string) => void): void {
    el.contentEditable = 'true';
    el.addEventListener('input', () => {
      onEdit(el.textContent ?? '');
      scheduleSave();
    });
    el.addEventListener('paste', (event) => {
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '');
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.blur();
      }
    });
  }

  makeEditable(titleEl, (text) => {
    data.t = text;
  });

  for (const el of tableWrapEl.querySelectorAll<HTMLElement>('[data-node-id]')) {
    const id = Number(el.dataset.nodeId);
    makeEditable(el, (text) => {
      if (id < data.i.length) {
        data.i[id] = text;
      } else {
        data.s[id - data.i.length].a = text;
      }
    });
  }

  for (const el of tableWrapEl.querySelectorAll<HTMLElement>('[data-prep-index]')) {
    const index = Number(el.dataset.prepIndex);
    makeEditable(el, (text) => {
      if (data.p) data.p[index] = text;
    });
  }
}

async function main(): Promise<void> {
  const payload = params.get('r');
  if (payload === null || payload === '') {
    fail('No recipe in this URL.');
    return;
  }

  const { data, layout } = await decodeRecipe(payload);

  titleEl.textContent = data.t;
  metaEl.textContent = formatRecipeMeta(data);
  tableWrapEl.innerHTML = renderTableHtml(layout, data.p);

  sourceEl.hidden = true;
  if (data.src) {
    try {
      sourceEl.href = data.src;
      sourceEl.textContent = new URL(data.src).hostname.replace(/^www\./, '');
      sourceEl.hidden = false;
    } catch {
      // Leave it hidden — an unparseable src is treated the same as none.
    }
  }

  if (!isEmbedded()) enableEditing(data, layout);
}

main().catch(() => fail('No readable recipe in this URL.'));

export {};
