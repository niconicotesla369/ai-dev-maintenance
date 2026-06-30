import { describe, expect, test } from 'vitest';
import { box, meter, stripAnsi, visibleLength, wrapText } from '../src/ui/components.js';

describe('terminal UI components', () => {
  test('renders a titled unicode box at a fixed width', () => {
    const output = box('SYSTEM', ['Ready'], { width: 24, color: false });

    expect(output).toContain('╭─ SYSTEM');
    expect(output).toContain('│ Ready');
    expect(output).toContain('╰');
    for (const line of output.trimEnd().split('\n')) {
      expect(visibleLength(line)).toBe(24);
    }
  });

  test('wraps long text without breaking borders', () => {
    const output = box('NEXT', ['Close idle browser tabs before restarting the Mac.'], { width: 34, color: false });
    const lines = output.trimEnd().split('\n');

    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => visibleLength(line) === 34)).toBe(true);
    expect(output).toContain('Close idle browser tabs before');
  });

  test('meters use filled and empty unicode blocks', () => {
    expect(meter(50, 100, 10, { color: false })).toBe('▰▰▰▰▰▱▱▱▱▱');
  });

  test('visible width ignores ANSI escape sequences', () => {
    expect(visibleLength('\u001b[36mAIDM\u001b[0m')).toBe(4);
    expect(stripAnsi('\u001b[36mAIDM\u001b[0m')).toBe('AIDM');
  });

  test('wrapText preserves words and does not emit over-wide lines', () => {
    const lines = wrapText('AIDM will wait instead of touching anything while Codex is open.', 24);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => visibleLength(line) <= 24)).toBe(true);
  });
});
