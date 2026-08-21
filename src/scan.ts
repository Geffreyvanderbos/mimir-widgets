/*
 * The builder for /qr URLs — and the decode side of the bonus ask: a
 * screenshot of a QR code, redrawn clean. Decoding happens entirely in this
 * tab via jsQR over a canvas's ImageData; the image is never sent anywhere,
 * same privacy shape as the GPX builder's file read.
 */

import jsQR from 'jsqr';
import { QR_EC_DEFAULT, QR_SIZE_DEFAULT, renderQr } from './qr-render';

const dataEl = document.getElementById('scan-data') as HTMLInputElement;
const labelEl = document.getElementById('scan-label') as HTMLInputElement;
const fileEl = document.getElementById('scan-file') as HTMLInputElement;
const dropEl = document.getElementById('scan-drop')!;
const errorEl = document.getElementById('scan-error')!;
const canvas = document.getElementById('scan-canvas') as HTMLCanvasElement;
const previewLabelEl = document.getElementById('scan-preview-label')!;
const previewDataEl = document.getElementById('scan-preview-data')!;
const urlEl = document.getElementById('scan-url') as HTMLTextAreaElement;
const copyEl = document.getElementById('scan-copy')!;
const openEl = document.getElementById('scan-open') as HTMLAnchorElement;

function showError(text: string): void {
  errorEl.textContent = text;
  errorEl.hidden = text === '';
}

async function build(): Promise<void> {
  const data = dataEl.value;
  const label = labelEl.value.trim();

  previewLabelEl.textContent = label || 'QR Code';
  const ok = await renderQr(canvas, data, QR_SIZE_DEFAULT, QR_EC_DEFAULT);
  previewDataEl.textContent = ok
    ? data
    : data === ''
      ? 'Type or paste some data, or drop in a screenshot below'
      : 'Could not encode this data';

  if (!ok) {
    urlEl.value = '';
    openEl.removeAttribute('href');
    return;
  }

  const target = new URL('/qr', location.origin);
  target.searchParams.set('data', data);
  if (label !== '') target.searchParams.set('label', label);

  const href = target.toString();
  urlEl.value = href;
  openEl.href = href;
}

async function decodeFile(file: File): Promise<void> {
  showError('');
  try {
    const bitmap = await createImageBitmap(file);
    const scratch = document.createElement('canvas');
    scratch.width = bitmap.width;
    scratch.height = bitmap.height;
    const ctx = scratch.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, scratch.width, scratch.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    if (result === null) {
      showError('No QR code found in that image.');
      return;
    }
    dataEl.value = result.data;
    void build();
  } catch {
    showError('That file could not be read.');
  }
}

dataEl.addEventListener('input', () => void build());
labelEl.addEventListener('input', () => void build());

fileEl.addEventListener('change', () => {
  const file = fileEl.files?.[0];
  if (file !== undefined) void decodeFile(file);
});

for (const eventName of ['dragenter', 'dragover'] as const) {
  dropEl.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropEl.classList.add('is-active');
  });
}

for (const eventName of ['dragleave', 'dragend'] as const) {
  dropEl.addEventListener(eventName, () => dropEl.classList.remove('is-active'));
}

dropEl.addEventListener('drop', (event) => {
  event.preventDefault();
  dropEl.classList.remove('is-active');
  const file = event.dataTransfer?.files?.[0];
  if (file !== undefined) void decodeFile(file);
});

let copyResetId: number | undefined;
copyEl.addEventListener('click', async () => {
  let copied = false;
  try {
    await navigator.clipboard.writeText(urlEl.value);
    copied = true;
  } catch {
    urlEl.select();
  }
  copyEl.textContent = copied ? 'Copied' : 'Press ⌘C';
  if (copyResetId !== undefined) clearTimeout(copyResetId);
  copyResetId = window.setTimeout(() => {
    copyEl.textContent = 'Copy URL';
  }, 1500);
});

void build();

export {};
