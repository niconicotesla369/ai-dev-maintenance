import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createMaintenancePlan } from '../plan.js';
import { runDoctor } from '../doctor.js';
import { runPressureDoctor } from '../pressure/doctor.js';
import { buildHistoryReport } from '../history.js';
import { latestReport, sanitizeReportForOutput } from '../reports.js';
import { redactPath } from '../paths.js';
import { TOOL_VERSION } from '../version.js';
import type { MaintenanceReport } from '../types.js';
import { jsonRpcError, jsonRpcResult, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js';

export type McpCommands = {
  runDoctor: (options?: {
    json?: boolean;
    showPaths?: boolean;
    persistReport?: boolean;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{ report: MaintenanceReport; reportPath?: string }>;
  runPressureDoctor: typeof runPressureDoctor | (() => Promise<unknown>);
  latestReport: typeof latestReport;
  runHistory: typeof buildHistoryReport | ((options?: { env?: NodeJS.ProcessEnv }) => Promise<unknown>);
  createPlan: typeof createMaintenancePlan;
};

export type McpRuntime = {
  env?: NodeJS.ProcessEnv;
  commands?: Partial<McpCommands>;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const MCP_TOOLS: McpTool[] = [
  {
    name: 'aidm_doctor',
    description: 'Run the aggregate AIDM doctor without writing a local report. To clean up, use aidm_plan; applying requires a human-visible CLI step.',
    inputSchema: emptyInputSchema()
  },
  {
    name: 'aidm_pressure',
    description: 'Inspect current AI development process pressure.',
    inputSchema: emptyInputSchema()
  },
  {
    name: 'aidm_report_latest',
    description: 'Read the latest saved redacted AIDM report.',
    inputSchema: emptyInputSchema()
  },
  {
    name: 'aidm_history',
    description: 'Read local AIDM report history and summarize growth trends.',
    inputSchema: emptyInputSchema()
  },
  {
    name: 'aidm_plan',
    description: 'Create a local private plan for a supported safe action. This does not apply the plan.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          enum: ['codex-fix', 'cursor-clean']
        }
      },
      required: ['action']
    }
  }
];
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';

export async function runMcpSession(input: string, runtime: McpRuntime = {}): Promise<string> {
  const commands = resolveMcpCommands(runtime.commands);
  const responses: string[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const response = await handleMcpLine(rawLine, { commands, env: runtime.env });
    if (response) responses.push(response);
  }
  return responses.join('\n') + (responses.length > 0 ? '\n' : '');
}

export async function serveMcpStream(
  input: Readable,
  output: Writable,
  runtime: McpRuntime = {}
): Promise<void> {
  const commands = resolveMcpCommands(runtime.commands);
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const rawLine of rl) {
    const response = await handleMcpLine(rawLine, { commands, env: runtime.env });
    if (response) await writeLine(output, `${response}\n`);
  }
}

function resolveMcpCommands(commands?: Partial<McpCommands>): McpCommands {
  return {
    runDoctor,
    runPressureDoctor,
    latestReport,
    runHistory: buildHistoryReport,
    createPlan: createMaintenancePlan,
    ...commands
  };
}

async function handleMcpLine(
  rawLine: string,
  runtime: { commands: McpCommands; env?: NodeJS.ProcessEnv }
): Promise<string | undefined> {
  const line = rawLine.trim();
  if (!line) return undefined;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return JSON.stringify(jsonRpcError(null, -32700, 'Parse error'));
  }
  const response = await handleMcpRequest(request, runtime);
  return response ? JSON.stringify(response) : undefined;
}

function writeLine(output: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(value, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function handleMcpRequest(
  request: JsonRpcRequest,
  runtime: { commands: McpCommands; env?: NodeJS.ProcessEnv }
): Promise<JsonRpcResponse | undefined> {
  if (request.id === undefined) {
    return undefined;
  }
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return jsonRpcError(requestId(request), -32600, 'Invalid Request');
  }

  if (request.method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
    return jsonRpcResult(requestId(request), {
      protocolVersion,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'ai-dev-maintenance',
        version: TOOL_VERSION
      }
    });
  }
  if (request.method === 'ping') {
    return jsonRpcResult(requestId(request), {});
  }
  if (request.method === 'tools/list') {
    return jsonRpcResult(requestId(request), {
      tools: MCP_TOOLS
    });
  }
  if (request.method === 'tools/call') {
    return await callTool(request, runtime);
  }
  return jsonRpcError(requestId(request), -32601, `Method not found: ${request.method}`);
}

function negotiateProtocolVersion(value: unknown): string {
  return typeof value === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(value)
    ? value
    : LATEST_PROTOCOL_VERSION;
}

async function callTool(
  request: JsonRpcRequest,
  runtime: { commands: McpCommands; env?: NodeJS.ProcessEnv }
): Promise<JsonRpcResponse> {
  const params = isRecord(request.params) ? request.params : {};
  const name = typeof params.name === 'string' ? params.name : '';
  const args = isRecord(params.arguments) ? params.arguments : {};
  try {
    switch (name) {
      case 'aidm_doctor': {
        const { report } = await runtime.commands.runDoctor({
          json: true,
          showPaths: false,
          persistReport: false,
          env: runtime.env
        });
        return toolResult(requestId(request), sanitizeReportForOutput(report));
      }
      case 'aidm_pressure':
        return toolResult(requestId(request), await runtime.commands.runPressureDoctor());
      case 'aidm_report_latest': {
        const latest = await runtime.commands.latestReport();
        return toolResult(requestId(request), latest ? {
          reportPath: redactPath(latest.path),
          report: sanitizeReportForOutput(latest.report)
        } : { reportPath: null, report: null });
      }
      case 'aidm_history':
        return toolResult(requestId(request), await runtime.commands.runHistory({ env: runtime.env }));
      case 'aidm_plan': {
        if (args.action !== 'codex-fix' && args.action !== 'cursor-clean') {
          return jsonRpcError(requestId(request), -32602, 'Invalid aidm_plan action');
        }
        return toolResult(requestId(request), await runtime.commands.createPlan({ action: args.action, env: runtime.env }));
      }
      default:
        return jsonRpcError(requestId(request), -32602, `Unknown tool: ${name}`);
    }
  } catch (error) {
    return jsonRpcError(requestId(request), -32000, redactPath(error instanceof Error ? error.message : String(error)));
  }
}

function toolResult(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return jsonRpcResult(id, {
    content: [{
      type: 'text',
      text: JSON.stringify(value, null, 2)
    }]
  });
}

function requestId(request: JsonRpcRequest): JsonRpcId {
  return request.id ?? null;
}

function emptyInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
