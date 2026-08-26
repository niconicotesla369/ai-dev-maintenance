import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  openVisualReport,
  startVisualReportSession,
  VISUAL_REPORT_SERVER_LIMITS,
  type VisualReportSession
} from '../src/visual-report/server.js';
import type { VisualReportModel } from '../src/visual-report/model.js';

const TOKEN = 'T'.repeat(43);
const NONCE = 'N'.repeat(43);
const sessions = new Set<VisualReportSession>();

afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.close('server-error')));
  sessions.clear();
});

describe('ephemeral visual report server', () => {
  test('pins every production network and lifecycle limit', () => {
    expect(VISUAL_REPORT_SERVER_LIMITS).toEqual({
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
  });

  test('serves only the tokenized document and two empty POST routes with hardened headers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aidm-visual-zero-file-'));
    const syntheticHome = path.join(root, 'home');
    const syntheticTemp = path.join(root, 'tmp');
    await mkdir(syntheticHome);
    await mkdir(syntheticTemp);
    const before = await tree(root);
    try {
      const session = await trackedSession();
      const url = new URL(session.url);

      expect(session.host).toBe('127.0.0.1');
      expect(session.port).toBeGreaterThan(0);
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.pathname).toBe(`/${TOKEN}/`);
      expect(url.pathname).toMatch(/^\/[A-Za-z0-9_-]{43}\/$/);
      expect(session.url).not.toContain('Codex');
      expect(session.url).not.toContain('1234');
      expect(session.server.maxConnections).toBe(8);
      expect(session.server.headersTimeout).toBe(5_000);
      expect(session.server.requestTimeout).toBe(5_000);
      expect(session.server.keepAliveTimeout).toBe(5_000);
      expect(session.server.maxRequestsPerSocket).toBe(256);

      const document = await request(session, `/${TOKEN}/`);
      expect(document.status).toBe(200);
      expect(document.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(document.body).toContain('<!doctype html>');
      expect(document.body).toContain(`nonce="${NONCE}"`);
      assertSecurityHeaders(document.headers);

      const heartbeat = await request(session, `/${TOKEN}/heartbeat`, {
        method: 'POST',
        origin: session.origin
      });
      expect(heartbeat.status).toBe(204);
      expect(heartbeat.body).toBe('');
      assertSecurityHeaders(heartbeat.headers);

      const close = await request(session, `/${TOKEN}/close`, {
        method: 'POST',
        origin: session.origin
      });
      expect(close.status).toBe(204);
      expect(await session.closed).toBe('page-close');

      expect(await tree(root)).toEqual(before);
      expect((await tree(root)).some((file) => file.endsWith('.html'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects wrong host, token, query, method, origin, and request bodies without echoing input', async () => {
    const session = await trackedSession({ closeGraceMs: 200 });
    const cases = [
      await request(session, '/wrong-token/'),
      await request(session, `/${TOKEN}/`, { host: 'localhost' }),
      await request(session, `/${TOKEN}/?report=secret`),
      await request(session, `/${TOKEN}/`, { method: 'PUT' }),
      await request(session, `/${TOKEN}/heartbeat`, { method: 'POST' }),
      await request(session, `/${TOKEN}/heartbeat`, { method: 'POST', origin: 'null' })
    ];

    expect(cases.map((response) => response.status)).toEqual([404, 404, 404, 405, 403, 403]);
    for (const response of cases) {
      assertSecurityHeaders(response.headers);
      expect(response.body).not.toContain('secret');
      expect(response.body).not.toContain(TOKEN);
    }

    const contentLength = await request(session, `/${TOKEN}/heartbeat`, {
      method: 'POST',
      origin: session.origin,
      headers: { 'Content-Length': '1' },
      body: 'x'
    });
    expect(contentLength.status).toBe(413);
    expect(contentLength.headers.connection).toBe('close');

    const transferEncoding = await request(session, `/${TOKEN}/heartbeat`, {
      method: 'POST',
      origin: session.origin,
      headers: { 'Transfer-Encoding': 'chunked' },
      body: 'x'
    });
    expect(transferEncoding.status).toBe(413);
    expect(transferEncoding.headers.connection).toBe('close');

    const expectContinue = await request(session, `/${TOKEN}/heartbeat`, {
      method: 'POST',
      origin: session.origin,
      headers: { Expect: '100-continue', 'Content-Length': '1' },
      body: 'x'
    });
    expect(expectContinue.status).toBe(413);
    expect(expectContinue.headers.connection).toBe('close');
  });

  test('validates injected token and nonce before opening a listener', async () => {
    await expect(startVisualReportSession(model(), {
      tokenFactory: () => 'short',
      nonceFactory: () => NONCE
    })).rejects.toThrow('invalid visual report token');
    await expect(startVisualReportSession(model(), {
      tokenFactory: () => TOKEN,
      nonceFactory: () => 'bad/nonce'
    })).rejects.toThrow('invalid visual report nonce');
  });

  test('generates separate 32-byte base64url token and nonce values', async () => {
    const session = await startVisualReportSession(model(), {
      timings: testTimings()
    });
    sessions.add(session);
    const token = new URL(session.url).pathname.split('/')[1]!;
    const document = await request(session, new URL(session.url).pathname);
    const nonce = /style-src 'nonce-([A-Za-z0-9_-]{43})'/.exec(String(document.headers['content-security-policy']))?.[1];

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).not.toBe(token);
    await session.close('page-close');
  });

  test('adds the same hardening headers to parser-level client errors', async () => {
    const session = await trackedSession();
    const raw = await rawRequest(
      session,
      `GET /${TOKEN}/ HTTP/1.1\r\nHost: ${session.host}:${session.port}\r\nContent-Length: invalid\r\n\r\n`
    );

    expect(raw).toContain('HTTP/1.1 400 Bad Request');
    expect(raw).toContain('Cache-Control: no-store');
    expect(raw).toContain('Content-Security-Policy:');
    expect(raw).toContain('Connection: close');
  });

  test('allows a reload to reconnect during close grace', async () => {
    const session = await trackedSession({ closeGraceMs: 50, idleTimeoutMs: 300, hardDeadlineMs: 500 });
    let closed = false;
    void session.closed.then(() => { closed = true; });

    expect((await request(session, `/${TOKEN}/`)).status).toBe(200);
    expect((await request(session, `/${TOKEN}/close`, { method: 'POST', origin: session.origin })).status).toBe(204);
    await delay(10);
    expect((await request(session, `/${TOKEN}/`)).status).toBe(200);
    await delay(70);
    expect(closed).toBe(false);

    await request(session, `/${TOKEN}/close`, { method: 'POST', origin: session.origin });
    expect(await session.closed).toBe('page-close');
  });

  test('does not let an in-flight heartbeat cancel an accepted close beacon', async () => {
    const session = await trackedSession({ closeGraceMs: 25, idleTimeoutMs: 200, hardDeadlineMs: 400 });
    await request(session, `/${TOKEN}/`);
    await request(session, `/${TOKEN}/close`, { method: 'POST', origin: session.origin });
    expect((await request(session, `/${TOKEN}/heartbeat`, { method: 'POST', origin: session.origin })).status).toBe(204);

    expect(await session.closed).toBe('page-close');
  });

  test('closes on first-view, idle, and hard deadlines with stable reasons', async () => {
    const firstView = await trackedSession({ firstViewTimeoutMs: 25, hardDeadlineMs: 300 });
    expect(await firstView.closed).toBe('first-view-timeout');

    const idle = await trackedSession({ idleTimeoutMs: 25, hardDeadlineMs: 300 });
    await request(idle, `/${TOKEN}/`);
    expect(await idle.closed).toBe('idle-timeout');

    const hard = await trackedSession({ idleTimeoutMs: 300, hardDeadlineMs: 30 });
    await request(hard, `/${TOKEN}/`);
    expect(await hard.closed).toBe('hard-timeout');
  });

  test('closes exactly once for signals, duplicate close calls, and server errors', async () => {
    const signalSource = new EventEmitter();
    const signaled = await trackedSession({ signalSource, hardDeadlineMs: 300 });
    expect(signalSource.listenerCount('SIGINT')).toBe(1);
    signalSource.emit('SIGINT');
    expect(await signaled.closed).toBe('signal');
    expect(signalSource.listenerCount('SIGINT')).toBe(0);

    const duplicate = await trackedSession({ hardDeadlineMs: 300 });
    let serverCloseCount = 0;
    duplicate.server.on('close', () => { serverCloseCount += 1; });
    const [first, second] = await Promise.all([
      duplicate.close('signal'),
      duplicate.close('server-error')
    ]);
    expect(first).toBe('signal');
    expect(second).toBe('signal');
    expect(serverCloseCount).toBe(1);

    const errored = await trackedSession({ hardDeadlineMs: 300 });
    errored.server.emit('error', new Error('synthetic server error'));
    expect(await errored.closed).toBe('server-error');
  });

  test('uses only trusted open with one URL argument and shell disabled', async () => {
    const calls: Array<{ command: string; args: string[]; shell: false }> = [];
    const result = await openVisualReport(model(), {
      tokenFactory: () => TOKEN,
      nonceFactory: () => NONCE,
      timings: testTimings({ closeGraceMs: 10 }),
      resolveCommandPath: async (name) => {
        expect(name).toBe('open');
        return '/usr/bin/open';
      },
      browserOpener: async (command, args, options) => {
        calls.push({ command, args, shell: options.shell });
        const url = new URL(args[0]!);
        setTimeout(() => {
          void requestUrl(url, `/${TOKEN}/`)
            .then(() => requestUrl(url, `/${TOKEN}/close`, { method: 'POST', origin: url.origin }));
        }, 0);
        return { code: 0, stdout: '', stderr: '' };
      }
    });

    expect(result).toBe('page-close');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: '/usr/bin/open',
      args: [`http://127.0.0.1:${new URL(calls[0]!.args[0]!).port}/${TOKEN}/`],
      shell: false
    });
    expect(calls[0]!.args).toHaveLength(1);
    expect(calls[0]!.args[0]).not.toContain('1234');
  });

  test('tears down immediately when browser launch fails', async () => {
    const result = await openVisualReport(model(), {
      tokenFactory: () => TOKEN,
      nonceFactory: () => NONCE,
      timings: testTimings(),
      resolveCommandPath: async () => '/usr/bin/open',
      browserOpener: async () => ({ code: 1, stdout: '', stderr: 'private failure detail' })
    });

    expect(result).toBe('launch-failed');
  });

  test('does not wait forever for an unresponsive browser opener after the session expires', async () => {
    const result = await Promise.race([
      openVisualReport(model(), {
        tokenFactory: () => TOKEN,
        nonceFactory: () => NONCE,
        timings: testTimings({ firstViewTimeoutMs: 20, hardDeadlineMs: 100 }),
        resolveCommandPath: async () => '/usr/bin/open',
        browserOpener: async () => await new Promise<never>(() => undefined)
      }),
      delay(250).then(() => 'test-timeout' as const)
    ]);

    expect(result).toBe('first-view-timeout');
  });

  test('does not launch the browser after a signal closes the session during command resolution', async () => {
    const signalSource = new EventEmitter();
    let releaseResolver!: (path: string) => void;
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve; });
    const resolverGate = new Promise<string>((resolve) => { releaseResolver = resolve; });
    let openerCalls = 0;
    const result = openVisualReport(model(), {
      tokenFactory: () => TOKEN,
      nonceFactory: () => NONCE,
      timings: testTimings({ hardDeadlineMs: 300 }),
      signalSource,
      resolveCommandPath: async () => {
        markResolverStarted();
        return await resolverGate;
      },
      browserOpener: async () => {
        openerCalls += 1;
        return { code: 0, stdout: '', stderr: '' };
      }
    });

    await resolverStarted;
    releaseResolver('/usr/bin/open');
    signalSource.emit('SIGINT');
    expect(await result).toBe('signal');
    expect(openerCalls).toBe(0);
  });
});

async function trackedSession(overrides: {
  firstViewTimeoutMs?: number;
  idleTimeoutMs?: number;
  closeGraceMs?: number;
  hardDeadlineMs?: number;
  signalSource?: EventEmitter;
} = {}): Promise<VisualReportSession> {
  const { signalSource, ...timings } = overrides;
  const session = await startVisualReportSession(model(), {
    tokenFactory: () => TOKEN,
    nonceFactory: () => NONCE,
    timings: testTimings(timings),
    signalSource
  });
  sessions.add(session);
  void session.closed.finally(() => sessions.delete(session));
  return session;
}

function testTimings(overrides: Record<string, number> = {}) {
  return {
    firstViewTimeoutMs: 150,
    idleTimeoutMs: 150,
    closeGraceMs: 15,
    hardDeadlineMs: 600,
    ...overrides
  };
}

function model(): VisualReportModel {
  return {
    generatedAt: '2026-08-26T00:00:00.000Z',
    reportStatus: 'ok',
    coverage: 'complete',
    volume: { diskLevel: 'unknown' },
    totals: { trackedBytes: 1_234, safeBytes: 1_234, reviewBytes: 0, protectedBytes: 0 },
    providers: [{ id: 'codex', bytes: 1_234 }],
    counts: { safe: 1, review: 0, protected: 0 },
    availablePlans: ['cursor-clean']
  };
}

type ResponseSnapshot = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function request(
  session: VisualReportSession,
  requestPath: string,
  options: {
    method?: string;
    host?: string;
    origin?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<ResponseSnapshot> {
  return requestUrl(new URL(session.url), requestPath, options);
}

async function requestUrl(
  url: URL,
  requestPath: string,
  options: {
    method?: string;
    host?: string;
    origin?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<ResponseSnapshot> {
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? url.host,
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      ...options.headers
    };
    const outgoing = http.request({
      host: '127.0.0.1',
      port: Number(url.port),
      path: requestPath,
      method: options.method ?? 'GET',
      headers
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode ?? 0,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    outgoing.on('error', reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

function assertSecurityHeaders(headers: http.IncomingHttpHeaders): void {
  expect(headers['cache-control']).toBe('no-store');
  expect(headers.pragma).toBe('no-cache');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  expect(headers['content-security-policy']).toBe(
    `default-src 'none'; style-src 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
}

async function tree(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    paths.push(relative);
    if (entry.isDirectory()) paths.push(...await tree(root, relative));
  }
  return paths.sort();
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function rawRequest(session: VisualReportSession, payload: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: session.host, port: session.port });
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}
