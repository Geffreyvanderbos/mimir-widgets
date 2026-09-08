import type { RecipeData, RecipeLayout } from './recipe-codec';
import { escapeHtml as esc } from './html-escape';

/* Shared between the widget (recipe.ts) and the builder's live preview
 * (recipes.ts), so what someone tunes in the builder is pixel-for-pixel
 * what the embed will show — same reason gpx.ts's preview box mirrors
 * oembed.ts's reported hike geometry. */

export function formatRecipeMeta(data: RecipeData): string {
  return [data.n ? `serves ${data.n}` : '', data.m ? `${data.m} min` : ''].filter(Boolean).join('  ·  ');
}

// Prep steps have no node id and don't belong in the merge tree — they run
// above it, one full-width row each, a plain label plus the instruction
// spanning every column the tree itself uses.
function renderPrepRow(text: string, cols: number): string {
  return `<tr><td class="recipe-cell recipe-prep-label">prep</td><td class="recipe-cell recipe-prep-text" colspan="${cols}">${esc(text)}</td></tr>`;
}

export function renderTableHtml(layout: RecipeLayout, prep?: string[]): string {
  const byRow = new Map<number, RecipeLayout['cells']>();
  for (const cell of layout.cells) {
    const row = byRow.get(cell.row) ?? [];
    row.push(cell);
    byRow.set(cell.row, row);
  }
  for (const cells of byRow.values()) cells.sort((a, b) => a.col - b.col);

  const rows: string[] = (prep ?? []).map((text) => renderPrepRow(text, layout.cols));
  for (let r = 0; r < layout.rows; r++) {
    const cells = byRow.get(r) ?? [];
    const tds = cells
      .map(
        // `--col` drives the left-to-right shading in style.css. Passed as a
        // custom property rather than a computed class/inline background
        // because a cell's true column is layout data (recipe-codec.ts's
        // buildLayout), not something a CSS structural selector could work
        // out on its own — nth-child doesn't line up once rowspans start
        // removing cells from later rows.
        (cell) =>
          `<td class="recipe-cell recipe-cell-${cell.kind}" style="--col:${cell.col}" rowspan="${cell.rowSpan}" colspan="${cell.colSpan}">${esc(cell.text)}</td>`,
      )
      .join('');
    rows.push(`<tr>${tds}</tr>`);
  }
  return `<table class="recipe-table"><tbody>${rows.join('')}</tbody></table>`;
}
