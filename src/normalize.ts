// Layer 1 of deduplication: deterministic, free, and always runs.
// Catches "Milk" / "milk" / "get milk" / "some milk please" before any AI call.

const FILLER = new Set([
  'a', 'an', 'the', 'some', 'any', 'more', 'please', 'pls', 'plz',
  'get', 'buy', 'grab', 'pick', 'up', 'need', 'we', 'i', 'also',
  'and', 'add', 'to', 'of', 'for',
]);

/** Lowercase, strip punctuation, drop filler words, de-pluralize naively. */
export function canonicalize(raw: string): string {
  const words = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s%]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER.has(w))
    .map(depluralize);

  return words.join(' ').trim();
}

function depluralize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

/** Title-case for the reply, preserving things people wrote in caps. */
export function displayCase(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => (w === w.toUpperCase() && w.length > 1 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Naive comma/and split — the fallback splitter when the AI call fails. */
export function naiveSplit(raw: string): string[] {
  return raw
    .split(/,|\band\b|\n|\+|&|;/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
