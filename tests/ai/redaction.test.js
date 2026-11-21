import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/ai/index.js';

describe('AI source redaction', () => {
  it('redacts credential-like literals while keeping the code around them', () => {
    const source = 'const apiKey = "abcdef123456";\nconst other = 1;';

    const result = redactSecrets(source);

    expect(result.content).toBe('const apiKey = "[REDACTED]";\nconst other = 1;');
    expect(result.redactions).toBe(1);
    expect(source).toBe('const apiKey = "abcdef123456";\nconst other = 1;');
  });

  it('redacts known token prefixes inside comments', () => {
    const result = redactSecrets('// legacy token sk_live_abcdef123456\nconst x = 1;');

    expect(result.content).toBe('// legacy token [REDACTED]\nconst x = 1;');
    expect(result.redactions).toBe(1);
  });

  it('redacts bearer tokens', () => {
    const result = redactSecrets(
      '// Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    );

    expect(result.content).toBe('// Authorization: Bearer [REDACTED]');
    expect(result.redactions).toBe(1);
  });

  it('redacts credential assignments in non-JS syntax too', () => {
    const result = redactSecrets('apiKey := "abcdef123456"\nprint("ok")');

    expect(result.content).toBe('apiKey := "[REDACTED]"\nprint("ok")');
    expect(result.redactions).toBe(1);
  });

  it('preserves line breaks and does not touch benign strings', () => {
    const source = [
      'const message = "eval(userInput)";',
      '// a helpful comment',
      'const token = process.env.TOKEN;',
    ].join('\n');

    const result = redactSecrets(source);

    expect(result.content).toBe(source);
    expect(result.redactions).toBe(0);
    expect(result.content.split('\n')).toHaveLength(3);
  });

  it('handles empty and non-string input', () => {
    expect(redactSecrets('')).toEqual({ content: '', redactions: 0 });
    expect(redactSecrets(undefined)).toEqual({ content: '', redactions: 0 });
  });
});
