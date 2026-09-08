// URL-safe base64 — the shared encode/decode step under every widget that
// carries binary-packed state in the URL (hike-codec.ts's track, recipe-
// codec.ts's compressed payload). Keeping the byte-string plumbing here
// once means a fix to it can't drift between codecs.

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
