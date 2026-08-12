import {
  type Color,
  clipToSrgb,
  formatDisplayP3,
  formatHex,
  formatHsl,
  formatHwb,
  formatLab,
  formatLch,
  formatOklab,
  formatOklch,
  formatRgb,
  inP3Gamut,
  inSrgbGamut,
  nearestNamed,
  parseColor,
  relativeLuminance,
} from './color-space';

const params = new URLSearchParams(location.search);

const swatchEl = document.getElementById('color-swatch')!;
const fillEl = document.getElementById('color-swatch-fill')!;
const inputEl = document.getElementById('color-input') as HTMLInputElement;
const nameEl = document.getElementById('color-name')!;
const gamutEl = document.getElementById('color-gamut')!;
const gridEl = document.getElementById('color-grid')!;
const pickerEl = document.getElementById('color-picker') as HTMLInputElement;

interface Format {
  label: string;
  format: (color: Color) => string;
  /** True for the spaces that can't hold a colour wider than sRGB. */
  srgbBound?: boolean;
}

const FORMATS: Format[] = [
  { label: 'Hex', format: formatHex, srgbBound: true },
  { label: 'RGB', format: formatRgb, srgbBound: true },
  { label: 'HSL', format: formatHsl, srgbBound: true },
  { label: 'HWB', format: formatHwb, srgbBound: true },
  { label: 'OKLCH', format: formatOklch },
  { label: 'OKLab', format: formatOklab },
  { label: 'LCH', format: formatLch },
  { label: 'Lab', format: formatLab },
  { label: 'Display P3', format: formatDisplayP3 },
];

interface Row {
  button: HTMLButtonElement;
  label: HTMLSpanElement;
  value: HTMLSpanElement;
  format: Format;
}

const rows: Row[] = FORMATS.map((format) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'color-row';

  const label = document.createElement('span');
  label.className = 'color-row-label';
  label.textContent = format.label;

  const value = document.createElement('span');
  value.className = 'color-row-value';

  button.append(label, value);
  gridEl.append(button);
  return { button, label, value, format };
});

// The async Clipboard API is the happy path, but this page runs as a
// cross-origin iframe inside someone else's app, where a Permissions-Policy
// that omits `clipboard-write` will reject the promise. The deprecated
// execCommand path isn't gated that way, so it's kept as the fallback — and
// if both fail, the text is left selected so a manual ⌘C still works.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.className = 'color-scratch';
    document.body.append(scratch);
    scratch.select();
    try {
      if (document.execCommand('copy')) return true;
    } catch {
      // Fall through to leaving the text selected.
    } finally {
      // Keeping it around would leave a stray focusable element in the card.
      setTimeout(() => scratch.remove(), 0);
    }
    return false;
  }
}

let resetId: number | undefined;

for (const row of rows) {
  row.button.addEventListener('click', async () => {
    const copied = await copyToClipboard(row.value.textContent ?? '');
    if (resetId !== undefined) clearTimeout(resetId);
    for (const other of rows) other.button.classList.remove('is-copied');
    row.button.classList.add('is-copied');
    row.label.textContent = copied ? 'Copied' : 'Press ⌘C';
    resetId = window.setTimeout(() => {
      row.button.classList.remove('is-copied');
      row.label.textContent = row.format.label;
    }, 1400);
  });
}

function render(color: Color) {
  const displayed = clipToSrgb(color);
  const withinSrgb = inSrgbGamut(color);
  const withinP3 = inP3Gamut(color);

  fillEl.style.background = formatHex(displayed);
  // Ink on the swatch has to contrast with the colour itself, not with the
  // page — this is the one surface in the widget that isn't --bg. The
  // threshold is where black and white ink reach equal WCAG contrast.
  swatchEl.classList.toggle('is-dark', relativeLuminance(displayed) < 0.18);

  // <input type="color"> only speaks 6-digit hex, so it gets the clipped,
  // opaque version — it's an entry point for picking a new colour, not a
  // second representation of the current one. On a colour it cannot express
  // it's disabled outright: touching it would otherwise overwrite a
  // wide-gamut input with a clipped hex, which is exactly the clamping this
  // widget goes out of its way not to do.
  pickerEl.value = formatHex({ ...displayed, alpha: 1 });
  pickerEl.disabled = !withinSrgb;
  pickerEl.title = withinSrgb ? 'Pick a colour' : 'Picker only reaches sRGB';

  const named = nearestNamed(color);
  nameEl.textContent = named.exact ? named.name : `≈ ${named.name}`;

  const outside = !withinSrgb ? (withinP3 ? 'outside sRGB' : 'outside sRGB and P3') : '';
  gamutEl.textContent = outside;
  gamutEl.hidden = outside === '';

  for (const row of rows) {
    row.value.textContent = row.format.format(color);
    row.value.title = row.value.textContent;
    // A wide-gamut colour still has to be *written* somehow in a space that
    // can't hold it, so those rows show the clipped value and say so rather
    // than quietly pretending the conversion was lossless. The unbounded
    // spaces (OKLCH, Lab, …) are never clipped and are never marked.
    const clipped =
      row.format.srgbBound === true
        ? !withinSrgb
        : row.format.format === formatDisplayP3 && !withinP3;
    row.button.classList.toggle('is-clipped', clipped);
  }
}

const DEFAULT_COLOR = '#006fdc';

let lastValid: Color = parseColor(DEFAULT_COLOR)!;

function update() {
  const parsed = parseColor(inputEl.value);
  inputEl.classList.toggle('is-invalid', parsed === null && inputEl.value.trim() !== '');
  if (parsed === null) return;
  lastValid = parsed;
  render(parsed);
}

// A link written by hand as `?c=#006fdc` puts the colour in the URL's
// *fragment*, not its query: the `#` starts the fragment, so `c` arrives
// present but empty. Reading the fragment as a fallback makes that link work
// as written, and falling back on an empty string — rather than only on a
// missing one — stops the field sitting blank behind its placeholder while the
// card renders a colour the field doesn't show.
function requestedColor(): string {
  const queried = params.get('c')?.trim();
  if (queried) return queried;
  const fragment = decodeURIComponent(location.hash).trim();
  return fragment.length > 1 && parseColor(fragment) !== null ? fragment : DEFAULT_COLOR;
}

inputEl.value = requestedColor();
const initial = parseColor(inputEl.value);
if (initial !== null) lastValid = initial;
inputEl.classList.toggle('is-invalid', initial === null);
// A typo shouldn't blank the card: the swatch keeps whatever last parsed,
// which on load means the default when the ?c= itself was unreadable.
render(lastValid);

// What gets pasted is usually a colour with something attached — a trailing
// semicolon off a stylesheet, `color: #ff0000`, a whole declaration. Try the
// text whole first, then pick the first thing in it that parses.
function extractColor(text: string): string | null {
  if (parseColor(text) !== null) return text.trim();
  const candidates = text.match(/#[0-9a-f]{3,8}\b|[a-z-]+\([^()]*\)|[a-z]{3,}/gi) ?? [];
  return candidates.find((candidate) => parseColor(candidate) !== null) ?? null;
}

// Paste is caught on the document, not the field: the swatch is most of the
// card, and having to click into the input first would be a step for nothing.
// A paste that holds no colour is left to the browser, so ordinary editing
// inside the field still behaves.
document.addEventListener('paste', (event) => {
  const pasted = event.clipboardData?.getData('text') ?? '';
  const found = extractColor(pasted);
  if (found === null) return;
  event.preventDefault();
  inputEl.value = found;
  update();
  inputEl.focus();
  inputEl.select();
});

inputEl.addEventListener('input', update);
inputEl.addEventListener('focus', () => inputEl.select());
pickerEl.addEventListener('input', () => {
  inputEl.value = pickerEl.value;
  update();
});

export {};
