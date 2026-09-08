/*
 * The "recipe link parser" half of /recipes: given a page's URL, fetch it
 * server-side (most recipe sites send no CORS header, so the browser can't
 * do this itself) and pull out its schema.org Recipe JSON-LD — the same
 * structured data Google's rich-result cards read. That's "recipe schemed
 * website" in the CLAUDE.md sense: a page without it gets a clear 422
 * rather than an attempt at freeform HTML scraping, which would be a much
 * larger and much less reliable thing to build and maintain.
 *
 * What comes back is *extracted fields*, never the raw HTML — same argument
 * as the tile proxy and the nearby endpoint: returning only what the client
 * actually needs is what keeps this from being a general-purpose fetch
 * proxy, and it also means the page's markup, scripts and boilerplate never
 * reach the model in the next step (the client-side LLM call in recipes.ts).
 */

const MAX_RESPONSE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 10_000;

const JSON_HEADERS = { 'content-type': 'application/json' };

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

// "That page returned 403" names the number but not what it means — and
// 401/403 specifically is worth spelling out, since it's the single most
// common reason this fails: plenty of recipe sites block anything that
// doesn't look like a real browser, which a Workers fetch doesn't (a
// realistic User-Agent, set below, still isn't enough for some of them).
function describeUpstreamStatus(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return `blocked this request (${status}) — it's likely detecting and rejecting automated fetches`;
    case 404:
      return 'returned "not found" (404) — double-check the link';
    case 429:
      return 'is rate-limiting requests (429) — try again in a bit';
    default:
      return status >= 500 ? `is having server problems (${status})` : `returned an unexpected response (${status})`;
  }
}

// Defense in depth, not a complete SSRF barrier — Cloudflare's edge network
// already can't reach most private address space, but a hostname literal
// costs nothing to reject up front. Redirects are left to fetch()'s default
// following rather than re-validated hop by hop, which is a deliberate
// simplification: this endpoint returns extracted text fields, never bytes
// or a redirect target, so there's nothing for a malicious redirect to hand
// back to the caller even if it succeeded.
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
}

function capBytes(stream: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.terminate();
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [stripHtml(value)].filter(Boolean);
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map(stripHtml).filter(Boolean);
  }
  return [];
}

// recipeInstructions is the one field schema.org Recipe implementations
// disagree on most: a plain string (sometimes newline-separated, sometimes
// one HTML blob), an array of strings, an array of HowToStep objects, or
// HowToSection objects wrapping their own itemListElement. All four show up
// in the wild often enough to be worth handling rather than picking one.
function flattenInstructions(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string') {
    return value
      .split(/\r?\n+/)
      .map(stripHtml)
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenInstructions);
  }
  if (typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (node['@type'] === 'HowToSection' && node.itemListElement !== undefined) {
      return flattenInstructions(node.itemListElement);
    }
    if (typeof node.text === 'string') return [stripHtml(node.text)].filter(Boolean);
    if (typeof node.name === 'string') return [stripHtml(node.name)].filter(Boolean);
  }
  return [];
}

function normalizeYield(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'number') return String(first);
  if (typeof first === 'string' && first.trim() !== '') return first.trim();
  return undefined;
}

function parseIsoDurationMinutes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(value);
  if (match === null) return undefined;
  const total = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  return total > 0 ? total : undefined;
}

function hasRecipeType(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.includes('Recipe');
}

function findRecipe(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipe(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (hasRecipeType(record)) return record;
    if (record['@graph'] !== undefined) return findRecipe(record['@graph']);
  }
  return null;
}

async function extractJsonLd(html: ReadableStream<Uint8Array>, contentType: string): Promise<unknown[]> {
  const blocks: string[] = [];
  let current = '';

  await new HTMLRewriter()
    .on('script[type="application/ld+json"]', {
      element() {
        current = '';
      },
      text(chunk) {
        current += chunk.text;
        if (chunk.lastInTextNode) blocks.push(current);
      },
    })
    .transform(new Response(html, { headers: { 'content-type': contentType } }))
    .text();

  const parsed: unknown[] = [];
  for (const block of blocks) {
    try {
      parsed.push(JSON.parse(block));
    } catch {
      // Plenty of sites ship slightly malformed JSON-LD (trailing commas,
      // stray comments) — skip the block rather than failing the request.
    }
  }
  return parsed;
}

export const onRequest: PagesFunction = async (context) => {
  const requestUrl = new URL(context.request.url);
  const targetParam = requestUrl.searchParams.get('url');
  if (targetParam === null || targetParam.trim() === '') {
    return err(400, 'Missing url parameter');
  }

  let target: URL;
  try {
    target = new URL(targetParam);
  } catch {
    return err(400, 'That is not a valid URL.');
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return err(400, 'Only http/https URLs are supported.');
  }
  if (target.port !== '' && target.port !== '80' && target.port !== '443') {
    return err(400, 'Non-standard ports are not supported.');
  }
  if (isBlockedHost(target.hostname)) {
    return err(400, 'That host cannot be fetched.');
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // A bare Workers fetch gets 403'd by plenty of recipe sites; a
        // normal-looking browser UA is the difference between "works" and
        // "blocked" for a real fraction of them.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    });
  } catch (error) {
    return err(502, error instanceof Error && error.name === 'TimeoutError' ? 'That page took too long to load.' : 'Could not reach that URL.');
  }

  if (!upstream.ok) {
    return err(502, `That page ${describeUpstreamStatus(upstream.status)}.`);
  }
  const contentType = upstream.headers.get('content-type') ?? 'text/html';
  if (!contentType.includes('html') || upstream.body === null) {
    return err(422, "That URL didn't return a web page.");
  }

  let jsonLdBlocks: unknown[];
  try {
    jsonLdBlocks = await extractJsonLd(capBytes(upstream.body, MAX_RESPONSE_BYTES), contentType);
  } catch {
    return err(502, 'Could not read that page.');
  }

  const recipe = jsonLdBlocks.map(findRecipe).find((found) => found !== null) ?? null;
  if (recipe === null) {
    return err(422, 'No schema.org Recipe data found on that page.');
  }

  const ingredients = toStringArray(recipe.recipeIngredient ?? recipe.ingredients);
  if (ingredients.length === 0) {
    return err(422, "That page's recipe data has no ingredients.");
  }
  const instructions = flattenInstructions(recipe.recipeInstructions);
  if (instructions.length === 0) {
    return err(422, "That page's recipe data has no instructions.");
  }

  return new Response(
    JSON.stringify({
      title: typeof recipe.name === 'string' && recipe.name.trim() !== '' ? recipe.name.trim() : 'Recipe',
      ingredients,
      instructions,
      servings: normalizeYield(recipe.recipeYield),
      totalMinutes: parseIsoDurationMinutes(recipe.totalTime) ?? parseIsoDurationMinutes(recipe.cookTime),
      sourceUrl: target.toString(),
    }),
    { headers: JSON_HEADERS },
  );
};
