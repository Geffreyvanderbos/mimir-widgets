import { copyToClipboard } from './clipboard';

/*
 * The private half of the image host. Not a widget — a normal page on this
 * site, like the GPX builder, so it's absent from _middleware.ts's WIDGET_PATHS
 * and from oembed.ts's WIDGETS, and it isn't linked from the landing page.
 */

const tokenEl = document.getElementById('upload-token') as HTMLInputElement;
const dropEl = document.getElementById('upload-drop')!;
const fileEl = document.getElementById('upload-file') as HTMLInputElement;
const errorEl = document.getElementById('upload-error')!;
const statusEl = document.getElementById('upload-status')!;
const resultEl = document.getElementById('upload-result') as HTMLElement;
const thumbEl = document.getElementById('upload-thumb') as HTMLImageElement;
const detailEl = document.getElementById('upload-detail')!;
const pageEl = document.getElementById('upload-page') as HTMLInputElement;
const directEl = document.getElementById('upload-direct') as HTMLInputElement;
const copyPageEl = document.getElementById('upload-copy-page') as HTMLButtonElement;
const copyDirectEl = document.getElementById('upload-copy-direct') as HTMLButtonElement;
const openEl = document.getElementById('upload-open') as HTMLAnchorElement;

/* localStorage is per-origin, and this page is one page — no ?id= namespacing
 * needed (SKILL.md §7), just a prefix so it can't collide with a widget's own
 * state on the same origin. Nothing here expires: it's a credential the person
 * typed, and silently forgetting it would read as the token being wrong. */
const TOKEN_KEY = 'mimir-widgets:upload-token';

/* An embed is read at a column width, not at a phone camera's. 2000px is
 * generous for a retina render of a wide note and still an order of magnitude
 * off a 48MP original. */
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;
const MAX_BYTES = 10 * 1024 * 1024;

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

function setError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = message === '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Prepared {
  blob: Blob;
  type: string;
  width: number;
  height: number;
  /** Whether the bytes differ from what was chosen, for the size readout. */
  resized: boolean;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('Re-encoding failed.')) : resolve(blob)),
      type,
      quality,
    );
  });
}

/**
 * Shrink to MAX_EDGE and re-encode, which does three jobs at once: a smaller
 * file, dimensions known without parsing any headers (the oEmbed response needs
 * them), and EXIF dropped — including GPS, which matters for something whose
 * whole output is a URL meant to be pasted into a shared note.
 *
 * A GIF is passed through untouched: a canvas keeps exactly one frame, so
 * "resizing" one silently converts an animation into a still.
 */
async function prepare(file: File): Promise<Prepared> {
  const image = await loadImage(file);
  const { naturalWidth: width, naturalHeight: height } = image;

  if (file.type === 'image/gif') {
    return { blob: file, type: file.type, width, height, resized: false };
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  // A PNG is re-encoded even at scale 1, deliberately — that's the EXIF strip,
  // and it's also where a screenshot's oversized palette gets compacted.
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (context === null) {
    // No canvas means no dimensions and no strip; uploading the original would
    // fail server-side on the missing width/height anyway.
    throw new Error('This browser cannot re-encode images.');
  }
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  // PNG keeps its alpha; everything else becomes JPEG, which is far smaller for
  // a photograph and identical to look at on a note-sized card.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await toBlob(canvas, type, JPEG_QUALITY);

  return {
    blob,
    type,
    width: targetWidth,
    height: targetHeight,
    resized: blob.size !== file.size || targetWidth !== width,
  };
}

let currentThumb: string | null = null;

function showResult(prepared: Prepared, body: { page: string; direct: string; bytes: number }, original: File) {
  if (currentThumb !== null) URL.revokeObjectURL(currentThumb);
  currentThumb = URL.createObjectURL(prepared.blob);
  thumbEl.src = currentThumb;

  // The before/after is shown rather than hidden: a resize that went wrong is
  // much easier to catch here than after the URL is in three notes.
  const before = `${formatBytes(original.size)}`;
  const after = `${formatBytes(body.bytes)}`;
  detailEl.textContent = prepared.resized
    ? `${prepared.width}×${prepared.height} · ${before} → ${after}`
    : `${prepared.width}×${prepared.height} · ${after}, uploaded as-is`;

  pageEl.value = body.page;
  directEl.value = body.direct;
  openEl.href = body.page;
  resultEl.hidden = false;
}

async function upload(file: File) {
  setError('');
  resultEl.hidden = true;

  const token = tokenEl.value.trim();
  if (token === '') {
    setError('Paste the upload token first.');
    tokenEl.focus();
    return;
  }
  if (!SUPPORTED.has(file.type)) {
    setError(`${file.type || 'That file'} is not an image type this accepts.`);
    return;
  }

  try {
    statusEl.textContent = 'Reading…';
    const prepared = await prepare(file);
    if (prepared.blob.size > MAX_BYTES) {
      setError(`Still ${formatBytes(prepared.blob.size)} after resizing — over the 10MB limit.`);
      statusEl.textContent = '';
      return;
    }

    const form = new FormData();
    form.set('file', new File([prepared.blob], 'image', { type: prepared.type }));
    form.set('width', String(prepared.width));
    form.set('height', String(prepared.height));

    statusEl.textContent = `Uploading ${formatBytes(prepared.blob.size)}…`;
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });

    const body = (await response.json().catch(() => null)) as
      | { key: string; page: string; direct: string; bytes: number; error?: string }
      | null;

    if (!response.ok || body === null) {
      // 401 is the one worth naming: it's almost always a stale token in
      // storage rather than anything about the file.
      setError(
        response.status === 401
          ? 'That token was rejected.'
          : (body?.error ?? `Upload failed (${response.status}).`),
      );
      statusEl.textContent = '';
      return;
    }

    // Only remembered once it has actually worked, so a typo doesn't get
    // persisted and silently fail every later attempt.
    localStorage.setItem(TOKEN_KEY, token);
    statusEl.textContent = '';
    showResult(prepared, body, file);
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Something went wrong.');
    statusEl.textContent = '';
  }
}

function copyButton(button: HTMLButtonElement, source: HTMLInputElement, label: string) {
  let resetId: number | undefined;
  button.addEventListener('click', async () => {
    const copied = await copyToClipboard(source.value);
    button.textContent = copied ? 'Copied' : 'Press ⌘C';
    if (!copied) source.select();
    if (resetId !== undefined) clearTimeout(resetId);
    resetId = window.setTimeout(() => {
      button.textContent = label;
    }, 1600);
  });
}

copyButton(copyPageEl, pageEl, 'Copy Mimir URL');
copyButton(copyDirectEl, directEl, 'Copy image URL');

fileEl.addEventListener('change', () => {
  const [file] = fileEl.files ?? [];
  if (file !== undefined) void upload(file);
});

for (const event of ['dragenter', 'dragover'] as const) {
  dropEl.addEventListener(event, (e) => {
    e.preventDefault();
    dropEl.classList.add('is-active');
  });
}
for (const event of ['dragleave', 'drop'] as const) {
  dropEl.addEventListener(event, () => dropEl.classList.remove('is-active'));
}

dropEl.addEventListener('drop', (event) => {
  event.preventDefault();
  const [file] = event.dataTransfer?.files ?? [];
  if (file !== undefined) void upload(file);
});

// A screenshot goes to the clipboard, not to a file — pasting it is the fastest
// path this page has, and skipping the file picker entirely is most of why.
document.addEventListener('paste', (event) => {
  const [item] = [...(event.clipboardData?.files ?? [])];
  if (item === undefined) return;
  event.preventDefault();
  void upload(item);
});

tokenEl.value = localStorage.getItem(TOKEN_KEY) ?? '';

export {};
