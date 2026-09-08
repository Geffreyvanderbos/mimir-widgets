/*
 * A recipe table (see CLAUDE.md) is Michael Chu's cookingforengineers.com
 * format: ingredients listed top to bottom in the order they're first used,
 * cooking steps merging them left to right, each step's cell spanning
 * exactly the rows it combines, converging to one cell for the finished
 * dish. That's a tree — ingredients are leaves, each step is a node that
 * combines currently-live nodes — not a grid, and the payload stores it as
 * one: an LLM emits "combine these node ids, here's what you did" far more
 * reliably than it emits correct row/col/rowSpan/colSpan arithmetic, and the
 * only two ways this shape can be invalid are a dangling id or a
 * double-consumed one, both a one-line check. The grid geometry a `<table>`
 * needs is derived in `buildLayout`, never asked of the model.
 *
 * Node ids: ingredient k is id k; step k's output is id `i.length + k`.
 */

export interface RecipeStep {
  /** Node ids this step combines. */
  u: number[];
  /** What this step does, e.g. "whisk together". */
  a: string;
}

export interface RecipeData {
  t: string;
  i: string[];
  s: RecipeStep[];
  /**
   * Prep steps that don't depend on a specific ingredient and so have no
   * node id to hang off — "preheat the oven", "line a baking sheet". Drawn
   * as their own full-width rows above the merge table rather than forced
   * into the tree, which is where they'd otherwise have to fake a rowSpan.
   */
  p?: string[];
  /** Servings, as given (a string since "4-6" and "1 loaf" both show up). */
  n?: string;
  /** Total minutes, for the oEmbed title/height and a footer line. */
  m?: number;
  /** Source URL, credited under the table. */
  src?: string;
}

export interface RecipeCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  kind: 'ingredient' | 'action';
}

export interface RecipeLayout {
  rows: number;
  cols: number;
  cells: RecipeCell[];
}

/*
 * Ingredients are re-ordered to a DFS-from-the-root leaf order rather than
 * trusting `data.i`'s order as given. That's not just "reordering by first
 * use" (which the format wants automatically anyway) — it's load-bearing:
 * a step's rowSpan only draws as a rectangle if the rows it covers are
 * contiguous, and DFS over the tree is what guarantees that by construction.
 * Trusting an LLM's ingredient order directly would let a step's inputs land
 * on non-adjacent rows with no way to render it as one cell.
 */
export function buildLayout(data: RecipeData): RecipeLayout {
  const ingredientCount = data.i.length;
  const stepCount = data.s.length;
  const totalNodes = ingredientCount + stepCount;
  if (ingredientCount === 0 || stepCount === 0) {
    throw new Error('Recipe has no ingredients or steps.');
  }

  const consumedByStep = new Map<number, number>();
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
    const { u } = data.s[stepIndex];
    if (u.length === 0) {
      throw new Error(`Step ${stepIndex + 1} doesn't combine anything.`);
    }
    for (const id of u) {
      if (!Number.isInteger(id) || id < 0 || id >= ingredientCount + stepIndex) {
        throw new Error(`Step ${stepIndex + 1} references an unknown or not-yet-made node.`);
      }
      if (consumedByStep.has(id)) {
        throw new Error(`Node ${id} is used by more than one step.`);
      }
      consumedByStep.set(id, stepIndex);
    }
  }

  const unconsumed: number[] = [];
  for (let id = 0; id < totalNodes; id++) {
    if (!consumedByStep.has(id)) unconsumed.push(id);
  }
  if (unconsumed.length !== 1 || unconsumed[0] !== totalNodes - 1) {
    throw new Error('Recipe steps must converge to exactly one final step.');
  }

  const leafOrder: number[] = [];
  const firstRow = new Map<number, number>();
  const leafCount = new Map<number, number>();

  function visit(id: number): void {
    if (id < ingredientCount) {
      firstRow.set(id, leafOrder.length);
      leafCount.set(id, 1);
      leafOrder.push(id);
      return;
    }
    const startRow = leafOrder.length;
    for (const child of data.s[id - ingredientCount].u) visit(child);
    firstRow.set(id, startRow);
    leafCount.set(id, leafOrder.length - startRow);
  }
  visit(totalNodes - 1);

  if (leafOrder.length !== ingredientCount) {
    throw new Error('Every ingredient must be used by exactly one step.');
  }

  // Column = one past the latest column any of its inputs landed on;
  // ingredients all start the clock at column 0.
  const col = new Map<number, number>();
  for (let id = 0; id < ingredientCount; id++) col.set(id, 0);
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
    const id = ingredientCount + stepIndex;
    const inputCols = data.s[stepIndex].u.map((childId) => col.get(childId)!);
    col.set(id, 1 + Math.max(...inputCols));
  }
  const totalCols = Math.max(...Array.from(col.values())) + 1;

  // A node's cell stretches from its own column up to (not including) the
  // column of whatever consumes it, so a lane that's ready early but not
  // used until later still tiles the grid with no gap — the root has no
  // consumer, so it stretches to the last column instead.
  const cells: RecipeCell[] = [];
  for (let id = 0; id < totalNodes; id++) {
    const consumerStep = consumedByStep.get(id);
    const endCol = consumerStep === undefined ? totalCols : col.get(ingredientCount + consumerStep)!;
    cells.push({
      row: firstRow.get(id)!,
      col: col.get(id)!,
      rowSpan: leafCount.get(id)!,
      colSpan: endCol - col.get(id)!,
      text: id < ingredientCount ? data.i[id] : data.s[id - ingredientCount].a,
      kind: id < ingredientCount ? 'ingredient' : 'action',
    });
  }

  return { rows: ingredientCount, cols: totalCols, cells };
}

/* Byte 0 of the decompressed payload. Bumping this is how a future schema
 * change stays distinguishable from a link someone already saved in a note —
 * same reasoning as hike-codec.ts's FORMAT_VERSION, and more likely to be
 * needed here since this schema is fed by an LLM rather than a fixed parser. */
const FORMAT_VERSION = 1;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// deflate-raw over gzip: recipe JSON is small enough that gzip's ~18 bytes of
// header/checksum overhead is a real fraction of the encoded URL.
async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeRecipe(data: RecipeData): Promise<string> {
  // Fail on an unlayoutable tree before it's ever put in a URL, not when
  // some future reader's widget page decodes it.
  buildLayout(data);

  const json = new TextEncoder().encode(JSON.stringify(data));
  const versioned = new Uint8Array(json.length + 1);
  versioned[0] = FORMAT_VERSION;
  versioned.set(json, 1);

  return bytesToBase64Url(await compress(versioned));
}

export async function decodeRecipe(payload: string): Promise<RecipeData> {
  const versioned = await decompress(base64UrlToBytes(payload));
  if (versioned.length === 0 || versioned[0] !== FORMAT_VERSION) {
    throw new Error('Unrecognised recipe format.');
  }
  const data = JSON.parse(new TextDecoder().decode(versioned.slice(1))) as RecipeData;
  buildLayout(data); // validates shape before the caller trusts it
  return data;
}
