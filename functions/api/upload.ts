/*
 * The one writing route on this site: `POST /api/upload` → an image in R2, and
 * a pair of URLs back (see functions/i/[[path]].ts for what they serve).
 *
 * Everything else here is a read of somebody else's data. This one takes a
 * secret and puts bytes in a bucket, in a public repo, so its guards are worth
 * stating rather than inferring:
 *
 * 1. The token is compared in constant time. A `===` on a secret leaks its
 *    length and, in principle, its prefix through timing; the fix costs four
 *    lines and removes the question.
 * 2. A missing or implausibly short UPLOAD_TOKEN fails closed. A misconfigured
 *    deploy that accepted `Bearer undefined` would be an open bucket, and the
 *    failure mode of the opposite mistake is only ever "I can't upload".
 * 3. The declared content-type is a *claim* — it comes from the multipart part,
 *    which is entirely client-supplied. The magic bytes are the fact, and the
 *    two must agree. Without this the bucket will happily serve an HTML
 *    document under `content-type: image/png`.
 * 4. SVG is not in the allowlist, deliberately. It is a scriptable document
 *    that happens to draw a picture, and this host's whole output is URLs meant
 *    to be pasted into other people's pages.
 */

const MAX_BYTES = 10 * 1024 * 1024;

/** Below this, assume the secret was never set rather than set to something
 *  short — a 6-character UPLOAD_TOKEN is a mistake, not a policy. */
const MIN_TOKEN_LENGTH = 32;

/* Every accepted type, with the byte prefix that proves it. WebP and AVIF are
 * RIFF/ISO-BMFF containers, so their marker sits past a 4-byte length field —
 * hence the offset rather than a flat prefix match. */
interface Magic {
  offset: number;
  bytes: number[];
}

const SIGNATURES: Record<string, Magic[]> = {
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'image/gif': [
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  ],
  // 'RIFF' .... 'WEBP'
  'image/webp': [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }],
  // .... 'ftyp' — the brand that follows ('avif', 'avis') is checked below.
  'image/avif': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
};

/** The extension each type gets in its direct URL. One per type, so the URL a
 *  person copies always matches what the bucket will actually serve. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

function matches(head: Uint8Array, magic: Magic): boolean {
  if (head.length < magic.offset + magic.bytes.length) return false;
  return magic.bytes.every((byte, i) => head[magic.offset + i] === byte);
}

function looksLike(head: Uint8Array, contentType: string): boolean {
  const signatures = SIGNATURES[contentType];
  if (signatures === undefined) return false;
  if (!signatures.some((magic) => matches(head, magic))) return false;

  // 'ftyp' alone only says ISO base media — an MP4 carries it too. The brand
  // in the next four bytes is what separates a still image from a video.
  if (contentType === 'image/avif') {
    const brand = String.fromCharCode(...head.slice(8, 12));
    return brand === 'avif' || brand === 'avis';
  }
  return true;
}

/** Compares without an early return, so the time taken doesn't depend on how
 *  much of the token was right. Length is compared first and separately: it
 *  leaks anyway through the response, and XOR-ing mismatched lengths needs a
 *  branch somewhere regardless. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* 12 chars of base32-ish alphabet ≈ 60 bits. These URLs are unlisted rather
 * than access-controlled, so the key is the only thing standing between a
 * stranger and an image — it must not be guessable, and must never be derived
 * from the filename, which would leak what the picture is of. */
const KEY_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';
const KEY_LENGTH = 12;

function generateKey(): string {
  const random = new Uint8Array(KEY_LENGTH);
  crypto.getRandomValues(random);
  return [...random].map((byte) => KEY_ALPHABET[byte % KEY_ALPHABET.length]).join('');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** A whole number of pixels, or nothing. Sent by the upload page, which knows
 *  the post-resize size; stored verbatim and later served as the oEmbed
 *  width/height that Mimir turns into the panel's aspect ratio. */
function parseDimension(value: File | string | null): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30000) return undefined;
  return parsed;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const expected = env.UPLOAD_TOKEN;
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) {
    // Deliberately not "the server has no token": that tells an attacker the
    // difference between misconfigured and locked.
    return json({ error: 'Uploads are not configured' }, 503);
  }

  const authorization = request.headers.get('authorization') ?? '';
  const offered = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!constantTimeEqual(offered, expected)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Cheap rejection before reading a body at all: the browser sends a real
  // length, and a wrong one is caught by the byteLength check further down.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return json({ error: 'Image is larger than 10MB' }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ error: 'Expected a file field' }, 400);
  }

  const contentType = file.type;
  if (SIGNATURES[contentType] === undefined) {
    return json({ error: `Unsupported image type: ${contentType || 'unknown'}` }, 415);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return json({ error: 'Image is empty' }, 400);
  }
  if (bytes.byteLength > MAX_BYTES) {
    return json({ error: 'Image is larger than 10MB' }, 413);
  }
  if (!looksLike(bytes.slice(0, 16), contentType)) {
    return json({ error: 'File contents do not match its type' }, 400);
  }

  const width = parseDimension(form.get('width'));
  const height = parseDimension(form.get('height'));
  if (width === undefined || height === undefined) {
    // Without these the oEmbed response can't describe a shape, and Mimir falls
    // back to a 220px box waiting on a postMessage a plain <img> never sends —
    // a broken-looking embed. Refusing the upload is the better failure.
    return json({ error: 'Missing image dimensions' }, 400);
  }

  const key = generateKey();
  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { width: String(width), height: String(height) },
  });

  const origin = new URL(request.url).origin;
  return json(
    {
      key,
      // The oEmbed-discoverable page — this is the one to paste into Mimir.
      page: `${origin}/i/${key}`,
      // The bytes themselves, for anywhere that wants an <img src> or unfurls
      // an image URL natively.
      direct: `${origin}/i/${key}.${EXTENSIONS[contentType]}`,
      width,
      height,
      bytes: bytes.byteLength,
    },
    201,
  );
};
