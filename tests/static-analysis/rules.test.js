import { describe, expect, it } from 'vitest';
import { scanSource } from '../../src/static-analysis/index.js';
import {
  debuggerStatementRule,
  dynamicCodeExecutionRule,
  emptyCatchRule,
  evalUseRule,
  hardcodedSecretRule,
  timerStringCodeRule,
} from '../../src/static-analysis/rules/index.js';

function matches(rule, source) {
  return rule.check(scanSource(source));
}

describe('eval-use rule', () => {
  it('detects direct, global-object and indirect eval calls', () => {
    const source = [
      'eval(userInput);',
      'window.eval(otherInput);',
      'globalThis.eval(thirdInput);',
      '(0, eval)(fourthInput);',
    ].join('\n');

    expect(matches(evalUseRule, source)).toHaveLength(4);
  });

  it('does not flag similar identifiers, member methods or masked text', () => {
    const source = [
      'const result = myEval(input);',
      'const other = evaluator.run(input);',
      'const message = "eval(input)";',
      '// eval(input)',
      '/* eval(input) */',
    ].join('\n');

    expect(matches(evalUseRule, source)).toEqual([]);
  });

  it('reports the line of the call', () => {
    expect(matches(evalUseRule, '\n\neval(input);')[0]).toMatchObject({
      lineStart: 3,
      lineEnd: 3,
    });
  });
});

describe('dynamic-code-execution rule', () => {
  it('detects Function constructors and VM execution helpers', () => {
    const source = [
      'const a = new Function("return 1");',
      'const b = Function("return 2");',
      'vm.runInNewContext(code);',
      'runInThisContext(moreCode);',
    ].join('\n');

    expect(matches(dynamicCodeExecutionRule, source)).toHaveLength(4);
  });

  it('does not duplicate a new Function() match', () => {
    expect(
      matches(dynamicCodeExecutionRule, 'new Function("return 1");'),
    ).toHaveLength(1);
  });

  it('ignores user-defined names and masked text', () => {
    const source = [
      'new FunctionWrapper(code);',
      'myFunction(code);',
      'const note = "new Function(x)";',
      '// Function("return x")',
    ].join('\n');

    expect(matches(dynamicCodeExecutionRule, source)).toEqual([]);
  });
});

describe('timer-string-code rule', () => {
  it('detects string callbacks passed to timers', () => {
    const source = [
      "setTimeout('doThing()', 100);",
      'window.setInterval(`tick()`, 50);',
    ].join('\n');

    expect(matches(timerStringCodeRule, source)).toHaveLength(2);
  });

  it('accepts function callbacks and ignores masked text', () => {
    const source = [
      'setTimeout(doThing, 100);',
      'setInterval(() => tick(), 50);',
      'mySetTimeout("doThing()", 100);',
      'const text = "setTimeout(\'x\')";',
      '// setTimeout("x", 1)',
    ].join('\n');

    expect(matches(timerStringCodeRule, source)).toEqual([]);
  });
});

describe('hardcoded-secret rule', () => {
  it('detects credential-like assignments and object properties', () => {
    const source = [
      'const apiKey = "abcdef123456";',
      'const config = { password: "hunter2secret" };',
      "const token: string = 'eyJhbGciOiJIUzI1NiJ9';",
      'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n');

    const found = matches(hardcodedSecretRule, source);

    expect(found).toHaveLength(4);
    expect(found.map((match) => match.lineStart)).toEqual([1, 2, 3, 4]);
  });

  it('ignores placeholders, short values, env vars and unrelated fields', () => {
    const source = [
      'const password = process.env.PASSWORD;',
      'const password2 = "changeme";',
      'const apiKey = "your-api-key-here";',
      'const secret = "abc";',
      'const label = "apiKey";',
      'const password = getPassword();',
      'const url = "https://example.com/path";',
    ].join('\n');

    expect(matches(hardcodedSecretRule, source)).toEqual([]);
  });

  it('does not match secrets mentioned only in comments or strings', () => {
    const source = [
      '// const apiKey = "sk_live_abcdef123456";',
      'const note = "password: hunter2secret";',
    ].join('\n');

    expect(matches(hardcodedSecretRule, source)).toEqual([]);
  });

  it('reports the detector without echoing the secret value', () => {
    const found = matches(
      hardcodedSecretRule,
      'const apiKey = "sk_live_abcdef123456";',
    );

    expect(found[0].metadata).toEqual({
      detector: 'known-prefix',
      field: 'apiKey',
    });
    expect(JSON.stringify(found)).not.toContain('sk_live_abcdef123456');
  });
});

describe('empty-catch rule', () => {
  it('detects empty catch blocks with and without a binding', () => {
    const source = ['try { risky(); } catch (error) {}', 'try { x(); } catch {}'].join('\n');

    expect(matches(emptyCatchRule, source)).toHaveLength(2);
  });

  it('accepts catch blocks that handle the error', () => {
    const source = [
      'try { risky(); } catch (error) { logger.warn(error); }',
      'try { risky(); } catch (error) { throw error; }',
    ].join('\n');

    expect(matches(emptyCatchRule, source)).toEqual([]);
  });
});

describe('debugger-statement rule', () => {
  it('detects debugger statements and ignores masked text', () => {
    const source = [
      'debugger;',
      '// debugger;',
      'const note = "debugger;";',
      'debuggerHelper();',
    ].join('\n');

    expect(matches(debuggerStatementRule, source)).toHaveLength(1);
    expect(matches(debuggerStatementRule, source)[0].lineStart).toBe(1);
  });
});
