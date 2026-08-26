const CLIENT_PATH = 'src/visual-report/client.ts';
const SERVER_PATH = 'src/visual-report/server.ts';
const BROWSER_NETWORK_PRIMITIVE = /\b(?:fetch\s*\(|navigator\s*\.\s*sendBeacon\s*\(|new\s+(?:WebSocket|EventSource|XMLHttpRequest|WebTransport|RTCPeerConnection)\b)/;
const NODE_NETWORK_PRIMITIVE = /\b(?:node:(?:https?|http2|net|dns|tls|dgram)|https?\s*\.\s*(?:get|request)\s*\(|net\s*\.\s*(?:connect|createConnection)\s*\(|tls\s*\.\s*connect\s*\(|dgram\s*\.\s*createSocket\s*\()/;
const NETWORK_COMMAND_LITERAL = /['"`](?:\/(?:usr\/bin|bin)\/)?(?:curl|wget|nc|ncat|telnet|ssh|scp|sftp|ftp)['"`]/;
const NETWORK_PRIMITIVE = new RegExp(
  [BROWSER_NETWORK_PRIMITIVE.source, NODE_NETWORK_PRIMITIVE.source, NETWORK_COMMAND_LITERAL.source].join('|')
);
const FETCH = /\bfetch\s*\(/g;
const SEND_BEACON = /\bnavigator\s*\.\s*sendBeacon\s*\(/g;
const LISTEN = /\b[A-Za-z_$][\w$]*\s*\.\s*listen\s*\(/g;

/**
 * Return policy violations for runtime source files. The visual-report lane is
 * deliberately structural: any variation from its fixed loopback shape fails.
 *
 * Input: ReadonlyArray<{ path: string, source: string }>
 * Output: string[]
 */
export function findRuntimeNetworkPolicyViolations(files) {
  const violations = [];
  for (const file of files) {
    if (file.path === CLIENT_PATH) {
      violations.push(...validateVisualReportClient(file.source));
      continue;
    }
    if (file.path === SERVER_PATH) {
      violations.push(...validateVisualReportServer(file.source));
      continue;
    }
    if (NETWORK_PRIMITIVE.test(file.source)) {
      violations.push(`runtime network primitive detected in ${file.path}`);
    }
  }
  return violations;
}

function validateVisualReportClient(source) {
  const fetchCount = [...source.matchAll(FETCH)].length;
  const sendBeaconCount = [...source.matchAll(SEND_BEACON)].length;
  const hasRelativeHeartbeatPath = /\b(?:let|const)\s+heartbeatPath\s*:\s*string\s*\|\s*null\s*=\s*config\.token\s*===\s*null\s*\?\s*null\s*:\s*`\/\$\{config\.token\}\/heartbeat`\s*;/.test(source);
  const hasRelativeClosePath = /\b(?:let|const)\s+closePath\s*:\s*string\s*\|\s*null\s*=\s*config\.token\s*===\s*null\s*\?\s*null\s*:\s*`\/\$\{config\.token\}\/close`\s*;/.test(source);
  const hasApprovedFetch = /\bfetch\s*\(\s*heartbeatPath\s*,/.test(source);
  const hasApprovedCloseBeacon = /\bnavigator\s*\.\s*sendBeacon\s*\(\s*closePath\s*\)\s*;/.test(source);
  const hasDisallowedPrimitive = /\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest|WebTransport|RTCPeerConnection)\b/.test(source) ||
    NODE_NETWORK_PRIMITIVE.test(source) || NETWORK_COMMAND_LITERAL.test(source);

  if (
    fetchCount !== 1 ||
    sendBeaconCount !== 1 ||
    !hasRelativeHeartbeatPath ||
    !hasRelativeClosePath ||
    !hasApprovedFetch ||
    !hasApprovedCloseBeacon ||
    hasDisallowedPrimitive
  ) {
    return ['visual report client must contain only the approved heartbeat fetch and close beacon'];
  }
  return [];
}

function validateVisualReportServer(source) {
  const httpImports = source.match(/\bnode:http\b/g) ?? [];
  const netImports = source.match(/\bnode:net\b/g) ?? [];
  const hasExactHttpImport = /^import http from 'node:http';$/m.test(source);
  const hasExactTypeOnlyNetImport = /^import type \{ AddressInfo \} from 'node:net';$/m.test(source);
  const hasFixedHost = /VISUAL_REPORT_SERVER_LIMITS\s*=\s*Object\.freeze\(\{[\s\S]*?\bhost:\s*'127\.0\.0\.1',/.test(source);
  const hasFixedListener = /server\.listen\(VISUAL_REPORT_SERVER_LIMITS\.port, VISUAL_REPORT_SERVER_LIMITS\.host\);/.test(source);
  const listenCount = [...source.matchAll(LISTEN)].length;
  const hasUnexpectedPrimitive = BROWSER_NETWORK_PRIMITIVE.test(source) ||
    /\b(?:node:(?:https|http2|dns|tls|dgram)|http\s*\.\s*(?:get|request)\s*\(|net\s*\.\s*(?:connect|createConnection)\s*\(|tls\s*\.\s*connect\s*\(|dgram\s*\.\s*createSocket\s*\()/.test(source) ||
    NETWORK_COMMAND_LITERAL.test(source);

  if (
    httpImports.length !== 1 ||
    netImports.length !== 1 ||
    !hasExactHttpImport ||
    !hasExactTypeOnlyNetImport ||
    !hasFixedHost ||
    !hasFixedListener ||
    listenCount !== 1 ||
    hasUnexpectedPrimitive
  ) {
    return ['visual report server must contain only the approved loopback listener'];
  }
  return [];
}
