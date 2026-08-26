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
        | 'missing-terminator';
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

export function analyzeSessionImageLine(
  line: string,
  minPayloadChars = MIN_SESSION_IMAGE_PAYLOAD_CHARS
): SessionImageLineAnalysis {
  const occurrences: SessionImageOccurrence[] = [];
  let blocked = false;
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const start = line.indexOf(IMAGE_MARKER, searchFrom);
    if (start === -1) break;

    const prefix = parseDataUrlPrefix(line, start);
    if (!prefix) {
      occurrences.push({
        kind: 'blocked',
        start,
        end: start + IMAGE_MARKER.length,
        reason: 'invalid-alphabet'
      });
      blocked = true;
      searchFrom = start + IMAGE_MARKER.length;
      continue;
    }

    let end = prefix.payloadStart;
    while (end < line.length && BASE64_CHAR.test(line[end])) end += 1;
    const payload = line.slice(prefix.payloadStart, end);
    const next = line[end];

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

  for (const occurrence of occurrences) Object.freeze(occurrence);
  Object.freeze(occurrences);
  const analysis: SessionImageLineAnalysis = { occurrences, blocked };
  Object.freeze(analysis);
  ANALYZED_LINE_BY_RESULT.set(analysis, line);
  return analysis;
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
