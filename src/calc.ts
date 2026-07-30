// The plain-number entry point, not the default 'mathjs' — the default
// pulls in BigNumber/Fraction/Complex support this widget has no use for,
// roughly 3.5x the bundle size for no behavioral difference here.
import { evaluate } from 'mathjs/number';

const textarea = document.getElementById('calc') as HTMLTextAreaElement;

// A line ending in "=" or ":" (optionally followed by a literal "?" — the
// QuickMathJS placeholder convention) asks to be replaced with its
// evaluated result; the trailing separator is kept, everything after it is
// swapped for the answer. A bare assignment ("a = 3", no trailing marker)
// still runs through `evaluate` to update scope, but the line itself is
// left untouched — matching the source project's behavior.
const PLACEHOLDER_RE = /^(.*?)([:=])\s*\??\s*$/;

function evalLine(line: string, scope: Record<string, unknown>): string {
  const match = line.match(PLACEHOLDER_RE);
  if (!match) {
    try {
      evaluate(line, scope);
    } catch {
      // Not a valid expression (plain prose sharing the block) — ignore.
    }
    return line;
  }

  const [, exprRaw, separator] = match;
  const expr = exprRaw.trim();
  if (!expr) return line;

  try {
    const result = evaluate(expr, scope);
    if (result === undefined) return line;
    // ":" reads as "label: value" (no space before the colon); "=" reads
    // as "expr = value" (space on both sides) — matches QuickMathJS's own
    // convention for the two placeholder styles.
    const rendered = separator === ':' ? `${expr}: ` : `${expr} = `;
    return `${rendered}${formatResult(result)}`;
  } catch {
    return line;
  }
}

function formatResult(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e10) / 1e10);
  }
  return String(value);
}

// Recomputes top-to-bottom with a fresh scope each time, so editing an
// earlier line and pressing Enter again correctly updates anything that
// depended on it further down — the same "replay the whole buffer" model
// QuickMathJS itself uses, just without its undo stack, unit-expansion, or
// natural-language syntax normalization.
function recompute(lines: string[]): string[] {
  const scope: Record<string, unknown> = {};
  return lines.map((line) => evalLine(line, scope));
}

textarea.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();

  const { value, selectionStart } = textarea;
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionStart);
  const caretLineIndex = before.split('\n').length; // index of the new blank line

  const lines = (before + '\n' + after).split('\n');
  const recomputed = recompute(lines);
  textarea.value = recomputed.join('\n');

  const caret = recomputed
    .slice(0, caretLineIndex)
    .reduce((sum, line) => sum + line.length + 1, 0);
  textarea.setSelectionRange(caret, caret);
});

textarea.focus();

export {};
