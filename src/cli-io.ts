import { createInterface } from 'node:readline/promises';

export type CliIo = {
  input?: string;
  isInputTty?: boolean;
  isOutputTty?: boolean;
  columns?: number;
  noColor?: boolean;
  write?: (text: string) => void | Promise<void>;
  readLine?: (prompt: string) => Promise<string>;
};

export type NormalizedCliIo = {
  isInputTty: boolean;
  isOutputTty: boolean;
  columns: number;
  noColor: boolean;
  writesLive: boolean;
  write: (text: string) => Promise<void>;
  readLine: (prompt: string) => Promise<string>;
  output: () => string;
};

export function normalizeCliIo(io?: CliIo): NormalizedCliIo {
  if (io) return normalizeInjectedIo(io);

  return {
    isInputTty: process.stdin.isTTY === true,
    isOutputTty: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 80,
    noColor: process.env.NO_COLOR !== undefined,
    writesLive: true,
    write: async (text) => {
      process.stdout.write(text);
    },
    readLine: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    output: () => ''
  };
}

function normalizeInjectedIo(io: CliIo): NormalizedCliIo {
  let output = '';
  const inputs = (io.input ?? '').split(/\n/);
  let inputIndex = 0;
  const write = async (text: string) => {
    output += text;
    await io.write?.(text);
  };

  return {
    isInputTty: io.isInputTty === true,
    isOutputTty: io.isOutputTty === true,
    columns: io.columns ?? 80,
    noColor: io.noColor === true,
    writesLive: false,
    write,
    readLine: async (prompt) => {
      output += prompt;
      if (io.readLine) return io.readLine(prompt);
      const answer = inputs[inputIndex] ?? '';
      inputIndex += 1;
      output += `${answer}\n`;
      return answer;
    },
    output: () => output
  };
}
