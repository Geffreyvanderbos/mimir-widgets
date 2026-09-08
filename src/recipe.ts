import { buildLayout, decodeRecipe } from './recipe-codec';
import { renderTableHtml } from './recipe-render';

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

  let data;
  try {
    data = await decodeRecipe(payload);
  } catch {
    fail('No readable recipe in this URL.');
    return;
  }

  const layout = buildLayout(data);

  titleEl.textContent = data.t;

  const metaParts: string[] = [];
  if (data.n) metaParts.push(`serves ${data.n}`);
  if (data.m) metaParts.push(`${data.m} min`);
  metaEl.textContent = metaParts.join('  ·  ');

  tableWrapEl.innerHTML = renderTableHtml(layout, data.p);

  if (data.src) {
    try {
      sourceEl.href = data.src;
      sourceEl.textContent = new URL(data.src).hostname.replace(/^www\./, '');
      sourceEl.hidden = false;
    } catch {
      sourceEl.hidden = true;
    }
  } else {
    sourceEl.hidden = true;
  }
}

main().catch(() => fail('No readable recipe in this URL.'));

export {};
