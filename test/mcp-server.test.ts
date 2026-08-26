import { describe, expect, expectTypeOf, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { runCli } from '../src/cli.js';
import { runMcpSession, serveMcpStream, type McpCommands } from '../src/mcp/server.js';
import { TOOL_VERSION } from '../src/version.js';
import type { MaintenanceReport } from '../src/types.js';
import type { PressureReport } from '../src/pressure/types.js';
import type { HistoryReport } from '../src/history.js';
import type { MaintenancePlanSummary } from '../src/plan.js';

const hostileAbsolutePath = ['/private', 'example', 'path'].join('/');
const RECORDED_MCP_SERVER_VERSION = '0.5.0';
type ExpectedMcpPlanAction = 'codex-fix' | 'cursor-clean';

describe('MCP stdio server', () => {
  test('tools/list exposes read-only tools and never exposes aidm_apply', async () => {
    const output = await runMcpSession(lines([
      request(1, 'initialize', {}),
      request(2, 'tools/list', {})
    ]), { commands: mockMcpCommands() });

    const responses = parseJsonLines(output);
    expect(responses[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: {
          name: 'ai-dev-maintenance'
        }
      }
    });
    const tools = responses[1].result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual([
      'aidm_doctor',
      'aidm_pressure',
      'aidm_report_latest',
      'aidm_history',
      'aidm_plan'
    ]);
    expect(tools).not.toContain('aidm_apply');
    const doctorTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === 'aidm_doctor');
    expect(doctorTool.description).toContain('aidm_plan');
    expect(doctorTool.description).toContain('human');
  });

  test('keeps browser-backed visual reporting completely outside the MCP surface', async () => {
    const output = await runMcpSession(lines([
      request(1, 'tools/list', {})
    ]), { commands: mockMcpCommands() });
    const tools = parseJsonLines(output)[0].result.tools;
    const serializedTools = JSON.stringify(tools);
    const serverSource = await readFile(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
    const routerSource = await readFile(new URL('../src/cli-router.ts', import.meta.url), 'utf8');
    const mcpBranch = sourceBetween(
      routerSource,
      "if (parsed.command === 'mcp' && parsed.args[0] === 'serve')",
      "if (parsed.command === 'report' && parsed.args.includes('--latest'))"
    );
    const forbidden = ['html', 'visual', 'browser', 'openVisualReport'];
    const expectedRuntimeKeys = [
      'createPlan',
      'latestReport',
      'runDoctor',
      'runHistory',
      'runPressureDoctor'
    ];

    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      'aidm_doctor',
      'aidm_pressure',
      'aidm_report_latest',
      'aidm_history',
      'aidm_plan'
    ]);
    for (const term of forbidden) {
      expect(serializedTools.toLowerCase()).not.toContain(term.toLowerCase());
      expect(serverSource.toLowerCase()).not.toContain(term.toLowerCase());
      expect(mcpBranch.toLowerCase()).not.toContain(term.toLowerCase());
    }
    expect(injectedMcpCommandKeys(mcpBranch)).toEqual([
      expectedRuntimeKeys,
      expectedRuntimeKeys
    ]);
    type McpHasVisualCallback = 'openVisualReport' extends keyof McpCommands ? true : false;
    expectTypeOf<McpHasVisualCallback>().toEqualTypeOf<false>();
  });

  test('MCP plan command type stays narrower than the internal maintenance action union', () => {
    type McpPlanOptions = Parameters<McpCommands['createPlan']>[0];

    expectTypeOf<McpPlanOptions['action']>().toEqualTypeOf<ExpectedMcpPlanAction>();
  });

  test('rejects every v0.6 maintenance action before plan creation', async () => {
    let createPlanCalls = 0;
    const actions = [
      'codex-sparkle-clean',
      'codex-session-image-prune',
      'codex-session-monitor-install',
      'codex-session-monitor-remove'
    ];
    const output = await runMcpSession(lines(actions.map((action, index) => request(index + 1, 'tools/call', {
      name: 'aidm_plan',
      arguments: { action }
    }))), {
      commands: {
        ...mockMcpCommands(),
        createPlan: async () => {
          createPlanCalls += 1;
          return maintenancePlanSummary('cursor-clean');
        }
      }
    });

    expect(parseJsonLines(output).map((response) => response.error)).toEqual(actions.map(() => ({
      code: -32602,
      message: 'Invalid aidm_plan action'
    })));
    expect(createPlanCalls).toBe(0);
  });

  test('rejects unadvertised reclaim, status, monitoring, scheduled, and apply tools', async () => {
    const toolNames = [
      'aidm_apply',
      'aidm_codex_sparkle_clean',
      'aidm_reclaim_scan_codex_session_images',
      'aidm_codex_session_image_prune',
      'aidm_reclaim_status_codex_native_compression',
      'aidm_monitor_codex_sessions',
      'aidm_scheduled_monitor',
      'aidm_codex_session_monitor_install',
      'aidm_codex_session_monitor_remove'
    ];
    const output = await runMcpSession(lines(toolNames.map((name, index) => request(index + 1, 'tools/call', {
      name,
      arguments: {}
    }))), { commands: mockMcpCommands() });

    expect(parseJsonLines(output).map((response) => response.error)).toEqual(toolNames.map(() => ({
      code: -32602,
      message: 'Unknown tool'
    })));
  });

  test('rejects undeclared aidm_plan arguments before command dispatch', async () => {
    let createPlanCalls = 0;
    const forbiddenArguments = [
      { action: 'cursor-clean', acceptImageLoss: true },
      { action: 'cursor-clean', planId: 'plan-private' },
      { action: 'codex-fix', yes: true },
      { action: 'cursor-clean', olderThanDays: 30 },
      { action: 'cursor-clean', minFileSizeBytes: 50 * 1024 ** 2 },
      { action: 'cursor-clean', thresholdBytes: 8 * 1024 ** 3 },
      { action: 'cursor-clean', growthThresholdBytes: 5 * 1024 ** 3 },
      { action: 'cursor-clean', path: hostileAbsolutePath }
    ];
    const output = await runMcpSession(lines(forbiddenArguments.map((argumentsValue, index) => request(index + 1, 'tools/call', {
      name: 'aidm_plan',
      arguments: argumentsValue
    }))), {
      commands: {
        ...mockMcpCommands(),
        createPlan: async () => {
          createPlanCalls += 1;
          return maintenancePlanSummary('cursor-clean');
        }
      }
    });

    expect(parseJsonLines(output).map((response) => response.error)).toEqual(forbiddenArguments.map(() => ({
      code: -32602,
      message: 'Invalid aidm_plan arguments'
    })));
    expect(createPlanCalls).toBe(0);
  });

  test('dispatches only the two legacy plan actions with no extra options', async () => {
    const env = { AIDM_TEST_HOME: '/synthetic/mcp-home' };
    const calls: Array<{ action: ExpectedMcpPlanAction; env?: NodeJS.ProcessEnv }> = [];
    const output = await runMcpSession(lines([
      request(1, 'tools/call', { name: 'aidm_plan', arguments: { action: 'codex-fix' } }),
      request(2, 'tools/call', { name: 'aidm_plan', arguments: { action: 'cursor-clean' } })
    ]), {
      env,
      commands: {
        ...mockMcpCommands(),
        createPlan: async (options: { action: ExpectedMcpPlanAction; env?: NodeJS.ProcessEnv }) => {
          calls.push(options);
          return maintenancePlanSummary(options.action);
        }
      }
    });

    expect(parseJsonLines(output).every((response) => response.error === undefined)).toBe(true);
    expect(calls).toEqual([
      { action: 'codex-fix', env },
      { action: 'cursor-clean', env }
    ]);
  });

  test('tools/call aidm_doctor returns sanitized JSON without persisting reports', async () => {
    let persistReport: boolean | undefined;
    const output = await runMcpSession(lines([
      request(1, 'tools/call', {
        name: 'aidm_doctor',
        arguments: {}
      })
    ]), {
      commands: {
        ...mockMcpCommands(),
        runDoctor: async (options) => {
          persistReport = options?.persistReport;
          return {
            report: {
              ...aggregateReport(),
              findings: {
                raw: hostileAbsolutePath,
                identity: {
                  dev: 1,
                  ino: 2,
                  uid: 3
                }
              }
            }
          };
        }
      }
    });

    expect(persistReport).toBe(false);
    const response = parseJsonLines(output)[0];
    const text = response.result.content[0].text;
    expect(text).not.toContain(hostileAbsolutePath);
    expect(text).not.toContain('"dev"');
    expect(text).not.toContain('"ino"');
    expect(text).not.toContain('"uid"');
    expect(JSON.parse(text)).toMatchObject({
      command: 'doctor',
      redacted: true
    });
  });

  test('unknown method returns JSON-RPC error and later requests still work', async () => {
    const output = await runMcpSession(lines([
      request(1, 'unknown/method', {}),
      request(2, 'tools/list', {})
    ]), { commands: mockMcpCommands() });

    const responses = parseJsonLines(output);
    expect(responses[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32601
      }
    });
    expect(responses[1].result.tools.length).toBeGreaterThan(0);
  });

  test('invalid JSON line returns an error response and processing continues', async () => {
    const output = await runMcpSession(`not-json\n${request(2, 'tools/list', {})}\n`, {
      commands: mockMcpCommands()
    });

    const responses = parseJsonLines(output);
    expect(responses[0]).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700
      }
    });
    expect(responses[1].result.tools.length).toBeGreaterThan(0);
  });

  test('mcp serve rejects TTY mode', async () => {
    const result = await runCli(['mcp', 'serve'], {
      io: {
        isInputTty: true,
        isOutputTty: true,
        columns: 100
      },
      commands: mockMcpCommands()
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('MCP stdio server requires piped input/output');
  });

  test('mcp serve processes piped JSON-RPC input', async () => {
    const result = await runCli(['mcp', 'serve'], {
      io: {
        input: `${request(1, 'tools/list', {})}\n`,
        isInputTty: false,
        isOutputTty: false
      },
      commands: mockMcpCommands()
    });

    expect(result.exitCode).toBe(0);
    expect(parseJsonLines(result.output)[0].result.tools.map((tool: { name: string }) => tool.name)).toContain('aidm_doctor');
  });

  test('streaming serve loop responds before stdin closes and echoes protocol version', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = collectOutputLines(output);
    const session = serveMcpStream(input, output, { commands: mockMcpCommands() });

    input.write(`${request(1, 'initialize', { protocolVersion: '2024-11-05' })}\n`);
    const initialize = JSON.parse(await lines.nextLine());
    expect(initialize.result.protocolVersion).toBe('2024-11-05');

    input.write(`${notification('notifications/initialized', {})}\n`);
    input.write(`${request(2, 'tools/list', {})}\n`);
    const tools = JSON.parse(await lines.nextLine());
    expect(tools.id).toBe(2);
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('aidm_apply');

    input.end();
    await session;
  });

  test('initialize falls back to the latest supported protocol for unknown client versions', async () => {
    const output = await runMcpSession(lines([
      request(1, 'initialize', { protocolVersion: '9999-99-99' })
    ]), { commands: mockMcpCommands() });

    const response = parseJsonLines(output)[0];
    expect(response.result.protocolVersion).toBe('2025-06-18');
  });

  test('Claude Code MCP handshake transcript fixture matches the server wire behavior', async () => {
    const transcript = await readTranscript('test/fixtures/mcp/claude-code-handshake.jsonl');
    const input = lines(transcript.client.map((message) => JSON.stringify(message)));
    const output = await runMcpSession(input, { commands: mockMcpCommands() });
    const initializeResponses = transcript.server.filter((message) => (
      message.result?.serverInfo !== undefined
    ));
    const [initializeResponse] = initializeResponses;
    if (
      initializeResponses.length !== 1
      || initializeResponse?.result.serverInfo.version !== RECORDED_MCP_SERVER_VERSION
    ) {
      throw new Error('Expected exactly one recorded MCP server version');
    }
    initializeResponse.result.serverInfo.version = TOOL_VERSION;

    expect(parseJsonLines(output)).toEqual(transcript.server);
    const tools = transcript.server[1].result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual([
      'aidm_doctor',
      'aidm_pressure',
      'aidm_report_latest',
      'aidm_history',
      'aidm_plan'
    ]);
    expect(tools).not.toContain('aidm_apply');
  });
});

function lines(values: string[]): string {
  return `${values.join('\n')}\n`;
}

function request(id: number, method: string, params: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params
  });
}

function notification(method: string, params: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params
  });
}

function collectOutputLines(output: PassThrough): { nextLine: () => Promise<string> } {
  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      newline = buffer.indexOf('\n');
    }
  });

  return {
    nextLine: async () => {
      const existing = lines.shift();
      if (existing !== undefined) return existing;
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for MCP response line')), 1000);
        waiters.push((line) => {
          clearTimeout(timeout);
          resolve(line);
        });
      });
    }
  };
}

function parseJsonLines(output: string): Array<Record<string, any>> {
  return output
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error('Expected bounded MCP branch in cli-router.ts');
  return source.slice(start, end);
}

function injectedMcpCommandKeys(source: string): string[][] {
  return [...source.matchAll(/commands:\s*\{(?<body>[^{}]+)\}/gu)].map((match) => {
    const body = match.groups?.body ?? '';
    return [...body.matchAll(/^\s*(?<key>[A-Za-z]+): commands\.[A-Za-z]+,?$/gmu)]
      .map((candidate) => candidate.groups?.key ?? '')
      .filter(Boolean)
      .sort();
  });
}

async function readTranscript(path: string): Promise<{
  client: Array<Record<string, any>>;
  server: Array<Record<string, any>>;
}> {
  const content = await readFile(path, 'utf8');
  const client: Array<Record<string, any>> = [];
  const server: Array<Record<string, any>> = [];
  for (const line of content.trim().split(/\n/)) {
    const entry = JSON.parse(line) as { direction: 'client' | 'server'; message: Record<string, any> };
    if (entry.direction === 'client') client.push(entry.message);
    else server.push(entry.message);
  }
  return { client, server };
}

function mockMcpCommands() {
  return {
    runDoctor: async () => ({ report: aggregateReport() }),
    runPressureDoctor: async (): Promise<PressureReport> => ({
      schemaVersion: 2,
      toolVersion: '0.5.0',
      generatedAt: '2026-07-04T00:00:00.000Z',
      command: 'pressure',
      status: 'ok',
      redacted: true,
      platform: 'darwin',
      memory: {},
      disk: {},
      processes: [],
      totals: {
        aiCpuPercent: 0,
        aiRssBytes: 0,
        aiProcessCount: 0,
        otherCpuPercent: 0,
        otherRssBytes: 0,
        otherProcessCount: 0,
        processCount: 0
      },
      pressureLevel: {
        overall: 'ok',
        cpu: 'ok',
        memory: 'ok',
        disk: 'ok',
        reasons: []
      },
      warnings: [],
      nextActions: []
    }),
    latestReport: async () => ({
      path: hostileAbsolutePath,
      report: aggregateReport()
    }),
    runHistory: async (): Promise<HistoryReport> => ({
      schemaVersion: 1,
      toolVersion: '0.5.0',
      generatedAt: '2026-07-04T00:00:00.000Z',
      command: 'history',
      status: 'ok',
      redacted: true,
      windowDays: 30,
      dataPoints: 0,
      providers: [],
      totals: {
        firstBytes: 0,
        lastBytes: 0,
        deltaBytes: 0,
        bytesPerDay: 0,
        sparkline: ''
      },
      warnings: [],
      nextActions: []
    }),
    createPlan: async (): Promise<MaintenancePlanSummary> => maintenancePlanSummary('cursor-clean')
  } satisfies McpCommands;
}

function maintenancePlanSummary(action: ExpectedMcpPlanAction): MaintenancePlanSummary {
  return {
    schemaVersion: 1,
    toolVersion: '0.5.0',
    planId: 'plan-2026-07-04T00-00-00-000Z-abcdef',
    action,
    status: 'ready',
    createdAt: '2026-07-04T00:00:00.000Z',
    expiresAt: '2026-07-04T00:15:00.000Z',
    identityHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    preview: {
      targetCount: 1,
      reclaimableBytes: 5
    },
    blockedReasons: [],
    warnings: []
  };
}

function aggregateReport(): MaintenanceReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.5.0',
    generatedAt: '2026-07-04T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'aggregate-ai-tools',
      pathCategory: 'ai-tools'
    },
    findings: {},
    metrics: {},
    blockedReasons: [],
    providers: [],
    totals: {
      totalBytes: 0,
      safeReclaimableBytes: 0,
      confirmBytes: 0,
      privateBytes: 0
    }
  };
}
