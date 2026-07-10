export type NameMatchDecision = 'match' | 'uncertain' | 'mismatch';

export interface NameMatchResult {
  decision: NameMatchDecision;
  score: number;
  normalizedExpected: string;
  normalizedObserved: string;
  reason: string;
}

const transliterationGroups: ReadonlyArray<ReadonlyArray<string>> = [
  ['ph', 'f'],
  ['ou', 'u'],
  ['oo', 'u'],
  ['ee', 'i'],
  ['aa', 'a'],
  ['kh', 'k'],
  ['sh', 's'],
  ['ch', 'c'],
];

export function normalizePersonName(value: string): string {
  let normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [from, to] of transliterationGroups) normalized = normalized.replaceAll(from, to);
  return normalized;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}

export function comparePersonNames(expected: string, observed: string): NameMatchResult {
  const normalizedExpected = normalizePersonName(expected);
  const normalizedObserved = normalizePersonName(observed);
  if (!normalizedExpected || !normalizedObserved) {
    return { decision: 'mismatch', score: 0, normalizedExpected, normalizedObserved, reason: 'empty_name' };
  }
  if (normalizedExpected === normalizedObserved) {
    return { decision: 'match', score: 1, normalizedExpected, normalizedObserved, reason: 'exact_normalized_match' };
  }

  const expectedTokens = normalizedExpected.split(' ').sort();
  const observedTokens = normalizedObserved.split(' ').sort();
  if (expectedTokens.join(' ') === observedTokens.join(' ')) {
    return { decision: 'match', score: 0.99, normalizedExpected, normalizedObserved, reason: 'same_tokens_different_order' };
  }

  const distance = levenshtein(normalizedExpected, normalizedObserved);
  const score = 1 - distance / Math.max(normalizedExpected.length, normalizedObserved.length);
  if (score >= 0.92) {
    return { decision: 'match', score, normalizedExpected, normalizedObserved, reason: 'minor_spelling_variation' };
  }
  if (score >= 0.72) {
    return { decision: 'uncertain', score, normalizedExpected, normalizedObserved, reason: 'requires_advisory_review' };
  }
  return { decision: 'mismatch', score, normalizedExpected, normalizedObserved, reason: 'names_differ' };
}

