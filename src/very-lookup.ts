import { ENTRIES, INTENSIFIERS, type Entry } from './very-words';

const INTENSIFIER_SET = new Set(INTENSIFIERS);

function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s'’-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "very tired", "so tired" and "tired" are all the same question, so every
 * leading intensifier is peeled off — but only while a word remains behind it,
 * since `pretty` is itself a headword ("very pretty") as well as an
 * intensifier ("pretty tired").
 */
export function headword(raw: string): string {
  const tokens = normalise(raw).split(' ').filter(Boolean);
  while (tokens.length > 1 && INTENSIFIER_SET.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

/** Bounded Levenshtein — gives up as soon as it can't come in under `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

export interface Match {
  /** What was actually looked up, once stripped of its intensifier. */
  key: string;
  /** Every entry for this exact headword — two when the word has two senses. */
  hits: Entry[];
  suggestions: Entry[];
}

function suggestionsFor(key: string): Entry[] {
  const prefixed = ENTRIES.filter((entry) => entry.word.startsWith(key));
  // Someone who typed a replacement rather than the thing being replaced has
  // already done the work; showing the headword says so, and shows what else
  // was on offer for it.
  const asReplacement = ENTRIES.filter((entry) => entry.alts.includes(key));
  const tolerance = key.length > 4 ? 2 : 1;
  const misspelled = ENTRIES.filter(
    (entry) => editDistance(entry.word, key, tolerance) <= tolerance,
  );

  const seen = new Set<string>();
  return [...prefixed, ...asReplacement, ...misspelled]
    .filter((entry) => {
      const id = `${entry.word}|${entry.sense ?? ''}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 6);
}

/**
 * A word for the card to open on, or for the shuffle to land on. `avoid` keeps
 * a shuffle from handing back the word already showing, which reads as a
 * broken button rather than as a coincidence.
 */
export function sampleWord(random: number, avoid?: string): string {
  // By word, not by entry: a two-sense headword is one word to learn, and
  // drawing from the entry list would deal `cheap` twice as often as `cold`.
  const offerable = [
    ...new Set(
      ENTRIES.filter((entry) => entry.onRequest !== true && entry.word !== avoid).map(
        (entry) => entry.word,
      ),
    ),
  ];
  return offerable[Math.min(Math.floor(random * offerable.length), offerable.length - 1)];
}

export function lookup(raw: string): Match {
  const key = headword(raw);
  if (key === '') return { key, hits: [], suggestions: [] };

  const hits = ENTRIES.filter((entry) => entry.word === key);
  if (hits.length > 0) return { key, hits, suggestions: [] };

  // A field holding nothing but "very" is a field that hasn't been filled in
  // yet, not a failed lookup — the peeling above leaves the last token behind
  // whatever it is, so this is where that case lands.
  if (INTENSIFIER_SET.has(key)) return { key: '', hits: [], suggestions: [] };

  const suggestions = suggestionsFor(key);
  if (suggestions.length > 0) return { key, hits, suggestions };

  // "tired out", "cold as ice" — a phrase whose first word is the adjective.
  const first = key.split(' ')[0];
  if (first !== key) {
    const fallback = ENTRIES.filter((entry) => entry.word === first);
    if (fallback.length > 0) return { key: first, hits: fallback, suggestions: [] };
    return { key, hits: [], suggestions: suggestionsFor(first) };
  }
  return { key, hits: [], suggestions: [] };
}
