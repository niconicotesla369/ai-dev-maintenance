export const MIN_SESSION_IMAGE_PAYLOAD_CHARS = 1024;

export const SESSION_IMAGE_PLACEHOLDER_PAYLOAD =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAHnRFWHRDb21tZW50AGFpZG0tc3RyaXBwZWQtaW1hZ2UtdjEFNd5PAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

export const SESSION_IMAGE_PLACEHOLDER_URL =
  `data:image/png;base64,${SESSION_IMAGE_PLACEHOLDER_PAYLOAD}`;

export type SessionImageOccurrence =
  | { kind: 'replace'; start: number; end: number; payloadChars: number; mime: string }
  | {
      kind: 'skip';
      start: number;
      end: number;
      reason: 'known-placeholder' | 'below-min-payload';
    }
  | {
      kind: 'blocked';
      start: number;
      end: number;
      reason:
        | 'invalid-alphabet'
        | 'invalid-length'
        | 'invalid-padding'
        | 'non-canonical-base64'
        | 'unsafe-terminator'
        | 'missing-terminator'
        | 'unverifiable-context';
    };

export type SessionImageLineAnalysis = {
  occurrences: SessionImageOccurrence[];
  blocked: boolean;
};

const ANALYZED_LINE_BY_RESULT = new WeakMap<SessionImageLineAnalysis, string>();
const IMAGE_MARKER = 'data:image/';
const BASE64_SEPARATOR = ';base64,';
const MIME_CHAR = /^[A-Za-z0-9.+-]$/;
const BASE64_CHAR = /^[A-Za-z0-9+/=]$/;
const VALID_PADDING = /^[A-Za-z0-9+/]*={0,2}$/;
const SAFE_TERMINATORS = new Set(['"', "'", '\\', ')', ' ', '\t', '\n', '.', '…']);
const STANDALONE_DATA_URL_VALUE = /^data:image\/[A-Za-z0-9.+-]{1,32};base64,[A-Za-z0-9+/=]*$/;

// Only JSON string values that are exactly one base64 image data URL are images;
// data URLs embedded in text (tool output, pasted code, markdown) are conversation content.
export function analyzeSessionImageLine(
  line: string,
  minPayloadChars = MIN_SESSION_IMAGE_PAYLOAD_CHARS
): SessionImageLineAnalysis {
  const occurrences: SessionImageOccurrence[] = [];
  let blocked = false;
  let searchFrom = 0;

  const firstMarker = line.indexOf(IMAGE_MARKER);
  // `\u` escapes can spell an image value without a literal marker, so such lines are parsed too.
  if (firstMarker === -1 && !line.includes('\\u')) return freezeAnalysis(line, occurrences, false);
  const blockedStart = Math.max(firstMarker, 0);
  const blockedEnd = firstMarker === -1 ? 0 : firstMarker + IMAGE_MARKER.length;

  let expectedStandalone: number;
  try {
    expectedStandalone = countStandaloneDataUrlValues(JSON.parse(line));
  } catch {
    if (firstMarker === -1) return freezeAnalysis(line, occurrences, false);
    occurrences.push({ kind: 'blocked', start: blockedStart, end: blockedEnd, reason: 'unverifiable-context' });
    return freezeAnalysis(line, occurrences, true);
  }
  let standaloneSeen = 0;

  while (searchFrom < line.length) {
    const start = line.indexOf(IMAGE_MARKER, searchFrom);
    if (start === -1) break;

    const prefix = parseDataUrlPrefix(line, start);
    if (!prefix) {
      searchFrom = start + IMAGE_MARKER.length;
      continue;
    }

    let end = prefix.payloadStart;
    while (end < line.length && BASE64_CHAR.test(line[end])) end += 1;
    const payload = line.slice(prefix.payloadStart, end);
    const next = line[end];

    if (!isStandaloneJsonStringValue(line, start, end)) {
      searchFrom = Math.max(end, start + IMAGE_MARKER.length);
      continue;
    }
    standaloneSeen += 1;

    let occurrence: SessionImageOccurrence;
    if (payload === SESSION_IMAGE_PLACEHOLDER_PAYLOAD) {
      occurrence = { kind: 'skip', start, end, reason: 'known-placeholder' };
    } else {
      const reason = blockedReason(line, end, payload);
      if (reason) {
        occurrence = { kind: 'blocked', start, end, reason };
        blocked = true;
      } else if (payload.length < minPayloadChars) {
        occurrence = { kind: 'skip', start, end, reason: 'below-min-payload' };
      } else {
        occurrence = {
          kind: 'replace',
          start,
          end,
          payloadChars: payload.length,
          mime: prefix.mime
        };
      }
    }

    occurrences.push(occurrence);
    searchFrom = Math.max(end, start + IMAGE_MARKER.length);

    if (next === undefined) break;
  }

  // Escaped standalone values (e.g. `\/`, `d`) parse as images but cannot be located safely.
  if (standaloneSeen !== expectedStandalone) {
    occurrences.push({ kind: 'blocked', start: blockedStart, end: blockedEnd, reason: 'unverifiable-context' });
    blocked = true;
  }

  return freezeAnalysis(line, occurrences, blocked);
}

function freezeAnalysis(
  line: string,
  occurrences: SessionImageOccurrence[],
  blocked: boolean
): SessionImageLineAnalysis {
  for (const occurrence of occurrences) Object.freeze(occurrence);
  Object.freeze(occurrences);
  const analysis: SessionImageLineAnalysis = { occurrences, blocked };
  Object.freeze(analysis);
  ANALYZED_LINE_BY_RESULT.set(analysis, line);
  return analysis;
}

function isStandaloneJsonStringValue(line: string, start: number, end: number): boolean {
  const opening = start - 1;
  if (opening < 0 || line[opening] !== '"') return false;
  let backslashes = 0;
  for (let cursor = opening - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1;
  if (backslashes % 2 !== 0) return false;
  if (line[end] !== '"') return false;
  let cursor = end + 1;
  while (cursor < line.length && /\s/.test(line[cursor])) cursor += 1;
  return line[cursor] !== ':';
}

function countStandaloneDataUrlValues(root: unknown): number {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (STANDALONE_DATA_URL_VALUE.test(value)) count += 1;
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) stack.push(item);
    }
  }
  return count;
}

export function rewriteSessionImageLine(
  line: string,
  analysis: SessionImageLineAnalysis
): { output: string; imagesStripped: number; knownPlaceholders: number; skippedSmall: number } {
  // Rewriters accept only immutable analyses produced by this module for the same line.
  if (ANALYZED_LINE_BY_RESULT.get(analysis) !== line) {
    return {
      output: line,
      imagesStripped: 0,
      knownPlaceholders: 0,
      skippedSmall: 0
    };
  }

  const knownPlaceholders = analysis.occurrences.filter(
    (occurrence) => occurrence.kind === 'skip' && occurrence.reason === 'known-placeholder'
  ).length;
  const skippedSmall = analysis.occurrences.filter(
    (occurrence) => occurrence.kind === 'skip' && occurrence.reason === 'below-min-payload'
  ).length;

  if (analysis.blocked) {
    return { output: line, imagesStripped: 0, knownPlaceholders, skippedSmall };
  }

  const output: string[] = [];
  let cursor = 0;
  let imagesStripped = 0;
  for (const occurrence of analysis.occurrences) {
    if (occurrence.kind !== 'replace') continue;
    output.push(line.slice(cursor, occurrence.start), SESSION_IMAGE_PLACEHOLDER_URL);
    cursor = occurrence.end;
    imagesStripped += 1;
  }
  output.push(line.slice(cursor));

  return { output: output.join(''), imagesStripped, knownPlaceholders, skippedSmall };
}

function parseDataUrlPrefix(
  line: string,
  start: number
): { mime: string; payloadStart: number } | undefined {
  const mimeStart = start + IMAGE_MARKER.length;
  let cursor = mimeStart;
  while (cursor < line.length && cursor - mimeStart <= 32 && MIME_CHAR.test(line[cursor])) {
    cursor += 1;
  }

  const mimeLength = cursor - mimeStart;
  if (mimeLength < 1 || mimeLength > 32) return undefined;
  if (!line.startsWith(BASE64_SEPARATOR, cursor)) return undefined;

  return {
    mime: line.slice(mimeStart, cursor),
    payloadStart: cursor + BASE64_SEPARATOR.length
  };
}

function blockedReason(
  line: string,
  payloadEnd: number,
  payload: string
): Extract<SessionImageOccurrence, { kind: 'blocked' }>['reason'] | undefined {
  const next = line[payloadEnd];
  if (isUnsupportedPayloadContinuation(line, payloadEnd)) return 'invalid-alphabet';

  const invalidLength = payload.length % 4 !== 0;
  if (!VALID_PADDING.test(payload)) return 'invalid-padding';
  if (invalidLength) return 'invalid-length';
  if (Buffer.from(payload, 'base64').toString('base64') !== payload) {
    return 'non-canonical-base64';
  }
  if (next === undefined) return 'missing-terminator';
  if (!SAFE_TERMINATORS.has(next)) return 'unsafe-terminator';
  return undefined;
}

function isUnsupportedPayloadContinuation(line: string, payloadEnd: number): boolean {
  const next = line[payloadEnd];
  if (next === '-' || next === '_') return true;
  return next === '\\' && line[payloadEnd + 1] === '/';
}
