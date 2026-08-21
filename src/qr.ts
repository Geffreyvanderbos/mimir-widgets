import { copyToClipboard } from './clipboard';
import { clampQrSize, parseEcLevel, renderQr } from './qr-render';

const params = new URLSearchParams(location.search);

const labelEl = document.getElementById('qr-label')!;
const canvas = document.getElementById('qr-canvas') as HTMLCanvasElement;
const dataEl = document.getElementById('qr-data')!;
const copyEl = document.getElementById('qr-copy') as HTMLButtonElement;

const size = clampQrSize(params.get('size'));
const ec = parseEcLevel(params.get('ec'));
const label = params.get('label')?.trim() ?? '';
const data = params.get('data') ?? '';

labelEl.textContent = label || 'QR Code';

let copyResetId: number | undefined;

async function render(): Promise<void> {
  const ok = await renderQr(canvas, data, size, ec);
  dataEl.textContent = ok ? data : data === '' ? 'No ?data= given' : 'Could not encode this data';
  copyEl.hidden = !ok;
}

copyEl.addEventListener('click', async () => {
  const copied = await copyToClipboard(data);
  copyEl.textContent = copied ? 'Copied' : 'Press ⌘C';
  if (copyResetId !== undefined) clearTimeout(copyResetId);
  copyResetId = window.setTimeout(() => {
    copyEl.textContent = 'Copy data';
  }, 1500);
});

void render();

export {};
