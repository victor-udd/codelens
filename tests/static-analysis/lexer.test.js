import { describe, expect, it } from 'vitest';
import {
  createLineIndex,
  lineAt,
  scanSource,
} from '../../src/static-analysis/index.js';

describe('static analysis lexer', () => {
  it('maps offsets to one-based line numbers', () => {
    const lineStarts = createLineIndex('a\nbb\nccc');

    expect(lineStarts).toEqual([0, 2, 5]);
    expect(lineAt(lineStarts, 0)).toBe(1);
    expect(lineAt(lineStarts, 2)).toBe(2);
    expect(lineAt(lineStarts, 5)).toBe(3);
    expect(lineAt(lineStarts, 7)).toBe(3);
  });

  it('masks line and block comments while preserving newlines', () => {
    const context = scanSource('const a = 1; // eval(x)\n/* eval(y)\n eval(z) */\nconst b = 2;');

    expect(context.masked).not.toMatch(/eval/);
    expect(context.masked).toContain('const a = 1;');
    expect(context.masked).toContain('const b = 2;');
    expect(context.lineStarts).toHaveLength(4);
  });

  it('masks quoted string contents but keeps the delimiters', () => {
    const context = scanSource("const a = 'eval(one)'; const b = \"eval(two)\";");

    expect(context.masked).toContain("'         '");
    expect(context.masked).toContain('"         "');
    expect(context.strings.map((literal) => literal.value)).toEqual([
      'eval(one)',
      'eval(two)',
    ]);
  });

  it('masks template literals and skips interpolated templates for value rules', () => {
    const context = scanSource('const a = `eval(${code})`; const b = `eval(static)`;');

    expect(context.masked).not.toMatch(/eval/);
    expect(context.strings).toHaveLength(1);
    expect(context.strings[0].value).toBe('eval(static)');
  });

  it('masks regex literals without treating division as a regex', () => {
    const context = scanSource("const r = /eval\\(/g; const ratio = a / b;");

    expect(context.masked).not.toMatch(/eval/);
    expect(context.masked).toContain('a / b');
  });

  it('keeps escaped quotes inside a string from ending the literal early', () => {
    const context = scanSource("const password = 'it\\'s eval(x)'; const real = eval(input);");

    expect(context.strings).toHaveLength(1);
    expect(context.strings[0].value).toBe("it\\'s eval(x)");
    expect(context.masked).toMatch(/\beval\s*\(/);
  });

  it('handles empty input', () => {
    const context = scanSource('');

    expect(context.masked).toBe('');
    expect(context.strings).toEqual([]);
    expect(context.lineStarts).toEqual([0]);
  });
});
