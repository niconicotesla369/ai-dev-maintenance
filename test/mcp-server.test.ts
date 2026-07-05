import { describe, expect, test } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCli } from '../src/cli.js';
import { runMcpSession, serveMcpStream } from '../src/mcp/server.js';
import type { MaintenanceReport } from '../src/types.js';
import type { PressureReport } from '../src/pressure/types.js';
import type { HistoryReport } from '../src/history.js';
import type { MaintenancePlanSummary } from '../src/plan.js';

const hostileAbsolutePath = ['/private', 'example', 'path'].join('/');

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

function mockMcpCommands() {
  return {
    runDoctor: async () => ({ report: aggregateReport() }),
    runPressureDoctor: async (): Promise<PressureReport> => ({
      schemaVersion: 2,
      toolVersion: '0.4.0-beta.3',
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
      toolVersion: '0.4.0-beta.3',
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
    createPlan: async (): Promise<MaintenancePlanSummary> => ({
      schemaVersion: 1,
      toolVersion: '0.4.0-beta.3',
      planId: 'plan-2026-07-04T00-00-00-000Z-abcdef',
      action: 'cursor-clean',
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
    }),
    runFixSafe: async () => {
      throw new Error('fix must not be exposed through MCP');
    },
    runCursorSafeCleanup: async () => {
      throw new Error('cursor cleanup must not be exposed through MCP');
    },
    applyPlan: async () => {
      throw new Error('apply must not be exposed through MCP');
    }
  };
}

function aggregateReport(): MaintenanceReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.4.0-beta.3',
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
