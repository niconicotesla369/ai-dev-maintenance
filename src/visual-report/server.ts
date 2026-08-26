import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCommand as defaultRunCommand, trustedCommandPath as defaultTrustedCommandPath } from '../commands.js';
import type { CommandRunResult } from '../types.js';
import type { VisualReportModel } from './model.js';
import { renderVisualReportHtml } from './render.js';

export type VisualReportCloseReason =
  | 'page-close'
  | 'idle-timeout'
  | 'hard-timeout'
  | 'signal'
  | 'launch-failed'
  | 'first-view-timeout'
  | 'server-error';

export const VISUAL_REPORT_SERVER_LIMITS = Object.freeze({
  host: '127.0.0.1',
  port: 0,
  firstViewTimeoutMs: 30_000,
  heartbeatIntervalMs: 15_000,
  idleTimeoutMs: 90_000,
  closeGraceMs: 2_000,
  hardDeadlineMs: 30 * 60_000,
  maxHeaderBytes: 8 * 1024,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 256,
  maxConnections: 8
});

type VisualReportTimings = {
  firstViewTimeoutMs: number;
  idleTimeoutMs: number;
  closeGraceMs: number;
  hardDeadlineMs: number;
};

type SignalSource = {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
};

type BrowserOpenResult = Pick<CommandRunResult, 'code' | 'stdout' | 'stderr'> &
  Partial<Pick<CommandRunResult, 'timedOut'>>;

export type VisualReportRuntimeOptions = {
  tokenFactory?: () => string;
  nonceFactory?: () => string;
  timings?: Partial<VisualReportTimings>;
  signalSource?: SignalSource;
  resolveCommandPath?: typeof defaultTrustedCommandPath;
  browserOpener?: (
    command: string,
    args: string[],
    options: { shell: false }
  ) => Promise<BrowserOpenResult>;
};

export type VisualReportSession = {
  url: string;
  origin: string;
  host: '127.0.0.1';
  port: number;
  server: http.Server;
  closed: Promise<VisualReportCloseReason>;
  isClosing(): boolean;
  close(reason: VisualReportCloseReason): Promise<VisualReportCloseReason>;
};

const ROUTE_VALUE = /^[A-Za-z0-9_-]{43}$/;

export async function openVisualReport(
  model: VisualReportModel,
  options: VisualReportRuntimeOptions = {}
): Promise<VisualReportCloseReason> {
  const session = await startVisualReportSession(model, options);
  const launch = (async (): Promise<'launched' | 'launch-failed' | 'session-closed'> => {
    try {
      const resolveCommandPath = options.resolveCommandPath ?? defaultTrustedCommandPath;
      const resolution = await Promise.race([
        resolveCommandPath('open').then((openPath) => ({ kind: 'resolved' as const, openPath })),
        session.closed.then(() => ({ kind: 'closed' as const }))
      ]);
      if (resolution.kind === 'closed') return 'session-closed';
      if (session.isClosing()) return 'session-closed';
      const opener = options.browserOpener ?? defaultBrowserOpener;
      const result = await opener(resolution.openPath, [session.url], { shell: false });
      return result.code === 0 && result.timedOut !== true ? 'launched' : 'launch-failed';
    } catch {
      return 'launch-failed';
    }
  })();
  const outcome = await Promise.race([
    launch.then((status) => ({ kind: 'launch' as const, status })),
    session.closed.then((reason) => ({ kind: 'closed' as const, reason }))
  ]);
  if (outcome.kind === 'closed') {
    return outcome.reason;
  }
  if (outcome.status === 'session-closed') return await session.closed;
  if (outcome.status === 'launch-failed') return await session.close('launch-failed');
  return await session.closed;
}

export async function startVisualReportSession(
  model: VisualReportModel,
  options: VisualReportRuntimeOptions = {}
): Promise<VisualReportSession> {
  const token = options.tokenFactory?.() ?? randomRouteValue();
  const nonce = options.nonceFactory?.() ?? randomRouteValue();
  validateRouteValue(token, 'token');
  validateRouteValue(nonce, 'nonce');
  const timings = visualReportTimings(options.timings);
  const startedAt = Date.now();
  const expiresAtEpochMs = startedAt + timings.hardDeadlineMs;
  const signalSource = options.signalSource ?? process;
  let expectedHost = '';
  let origin = '';
  let html: string | null = renderVisualReportHtml(model, { token, nonce, expiresAtEpochMs });
  let viewed = false;
  let settledReason: VisualReportCloseReason | undefined;
  let closePromise: Promise<VisualReportCloseReason> | undefined;
  let firstViewTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let closeGraceTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let resolveClosed!: (reason: VisualReportCloseReason) => void;
  const closed = new Promise<VisualReportCloseReason>((resolve) => {
    resolveClosed = resolve;
  });

  const server = http.createServer({ maxHeaderSize: VISUAL_REPORT_SERVER_LIMITS.maxHeaderBytes }, handleRequest);
  server.maxConnections = VISUAL_REPORT_SERVER_LIMITS.maxConnections;
  server.headersTimeout = VISUAL_REPORT_SERVER_LIMITS.headersTimeoutMs;
  server.requestTimeout = VISUAL_REPORT_SERVER_LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = VISUAL_REPORT_SERVER_LIMITS.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = VISUAL_REPORT_SERVER_LIMITS.maxRequestsPerSocket;
  server.on('checkContinue', handleRequest);
  server.on('checkExpectation', (request, response) => {
    respond(request, response, 417, { Connection: 'close' }, true);
  });
  server.on('clientError', (_error, socket) => {
    if (!socket.writable || socket.destroyed) return;
    const headers = Object.entries(securityHeaders(nonce))
      .map(([name, value]) => `${name}: ${String(value)}`);
    socket.end([
      'HTTP/1.1 400 Bad Request',
      ...headers,
      'Connection: close',
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n'));
  });

  await listenOnLoopback(server);
  const address = server.address() as AddressInfo;
  const port = address.port;
  expectedHost = `${VISUAL_REPORT_SERVER_LIMITS.host}:${port}`;
  origin = `http://${expectedHost}`;
  const url = `${origin}/${token}/`;

  const onSignal = () => {
    void close('signal');
  };
  const onServerError = () => {
    void close('server-error');
  };
  signalSource.on('SIGINT', onSignal);
  server.on('error', onServerError);
  firstViewTimer = setTimeout(() => void close('first-view-timeout'), timings.firstViewTimeoutMs);
  hardTimer = setTimeout(
    () => void close('hard-timeout'),
    Math.max(1, expiresAtEpochMs - Date.now())
  );

  function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (hasRequestBody(request)) {
      respond(request, response, 413, { Connection: 'close' }, true);
      return;
    }
    if (settledReason !== undefined || request.headers.host !== expectedHost) {
      respond(request, response, 404);
      return;
    }

    const rootPath = `/${token}/`;
    const heartbeatPath = `/${token}/heartbeat`;
    const closePath = `/${token}/close`;
    const requestPath = request.url ?? '';
    const route = requestPath === rootPath
      ? 'document'
      : requestPath === heartbeatPath
        ? 'heartbeat'
        : requestPath === closePath
          ? 'close'
          : undefined;
    if (route === undefined) {
      respond(request, response, 404);
      return;
    }

    const expectedMethod = route === 'document' ? 'GET' : 'POST';
    if (request.method !== expectedMethod) {
      respond(request, response, 405, { Allow: expectedMethod });
      return;
    }
    if (route !== 'document' && request.headers.origin !== origin) {
      respond(request, response, 403);
      return;
    }

    if (route === 'document') {
      viewed = true;
      clearTimer(firstViewTimer);
      firstViewTimer = undefined;
      clearTimer(closeGraceTimer);
      closeGraceTimer = undefined;
      resetIdleTimer();
      respond(request, response, 200, { 'Content-Type': 'text/html; charset=utf-8' }, false, html ?? '');
      return;
    }
    if (!viewed) {
      respond(request, response, 404);
      return;
    }
    if (route === 'heartbeat') {
      if (closeGraceTimer !== undefined) {
        respond(request, response, 204);
        return;
      }
      resetIdleTimer();
      respond(request, response, 204);
      return;
    }

    clearTimer(idleTimer);
    idleTimer = undefined;
    clearTimer(closeGraceTimer);
    respond(request, response, 204);
    closeGraceTimer = setTimeout(() => void close('page-close'), timings.closeGraceMs);
  }

  function respond(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    status: number,
    extraHeaders: http.OutgoingHttpHeaders = {},
    closeConnection = false,
    body = ''
  ): void {
    response.writeHead(status, {
      ...securityHeaders(nonce),
      ...extraHeaders
    });
    response.end(status === 204 ? undefined : body);
    if (closeConnection) {
      response.once('finish', () => request.socket.destroy());
    }
  }

  function resetIdleTimer(): void {
    clearTimer(idleTimer);
    idleTimer = setTimeout(() => void close('idle-timeout'), timings.idleTimeoutMs);
  }

  function close(reason: VisualReportCloseReason): Promise<VisualReportCloseReason> {
    if (closePromise !== undefined) return closePromise;
    settledReason = reason;
    closePromise = new Promise((resolve) => {
      clearTimer(firstViewTimer);
      clearTimer(idleTimer);
      clearTimer(closeGraceTimer);
      clearTimer(hardTimer);
      firstViewTimer = undefined;
      idleTimer = undefined;
      closeGraceTimer = undefined;
      hardTimer = undefined;
      signalSource.off('SIGINT', onSignal);
      server.off('error', onServerError);
      html = null;

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolveClosed(reason);
        resolve(reason);
      };
      if (!server.listening) {
        finish();
        return;
      }
      server.close(finish);
      server.closeAllConnections();
    });
    return closePromise;
  }

  return {
    url,
    origin,
    host: VISUAL_REPORT_SERVER_LIMITS.host,
    port,
    server,
    closed,
    isClosing: () => settledReason !== undefined,
    close
  };
}

async function defaultBrowserOpener(
  command: string,
  args: string[],
  _options: { shell: false }
): Promise<BrowserOpenResult> {
  return await defaultRunCommand(command, args, {
    timeoutMs: 5_000,
    maxStdoutBytes: 16_000,
    maxStderrBytes: 16_000
  });
}

function listenOnLoopback(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(VISUAL_REPORT_SERVER_LIMITS.port, VISUAL_REPORT_SERVER_LIMITS.host);
  });
}

function securityHeaders(nonce: string): http.OutgoingHttpHeaders {
  return {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  };
}

function hasRequestBody(request: http.IncomingMessage): boolean {
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const contentLength = request.headers['content-length'];
  return contentLength !== undefined && contentLength !== '0';
}

function randomRouteValue(): string {
  return randomBytes(32).toString('base64url');
}

function validateRouteValue(value: string, kind: 'token' | 'nonce'): void {
  if (!ROUTE_VALUE.test(value)) throw new Error(`invalid visual report ${kind}`);
}

function visualReportTimings(overrides: Partial<VisualReportTimings> | undefined): VisualReportTimings {
  const timings = {
    firstViewTimeoutMs: overrides?.firstViewTimeoutMs ?? VISUAL_REPORT_SERVER_LIMITS.firstViewTimeoutMs,
    idleTimeoutMs: overrides?.idleTimeoutMs ?? VISUAL_REPORT_SERVER_LIMITS.idleTimeoutMs,
    closeGraceMs: overrides?.closeGraceMs ?? VISUAL_REPORT_SERVER_LIMITS.closeGraceMs,
    hardDeadlineMs: overrides?.hardDeadlineMs ?? VISUAL_REPORT_SERVER_LIMITS.hardDeadlineMs
  };
  for (const value of Object.values(timings)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid visual report timing');
  }
  if (timings.hardDeadlineMs > VISUAL_REPORT_SERVER_LIMITS.hardDeadlineMs) {
    throw new Error('invalid visual report timing');
  }
  return timings;
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}
