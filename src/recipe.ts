import { decodeRecipe } from './recipe-codec';
import { formatRecipeMeta, renderTableHtml } from './recipe-render';

const params = new URLSearchParams(location.search);
const titleEl = document.getElementById('recipe-title')!;
const metaEl = document.getElementById('recipe-meta')!;
const tableWrapEl = document.getElementById('recipe-table-wrap')!;
const sourceEl = document.getElementById('recipe-source') as HTMLAnchorElement;

function fail(message: string): void {
  titleEl.textContent = 'Recipe';
  metaEl.textContent = '';
  tableWrapEl.textContent = message;
  tableWrapEl.classList.add('is-empty');
  sourceEl.hidden = true;
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
}

main().catch(() => fail('No readable recipe in this URL.'));

export {};
