import { debuggerStatementRule } from './debugger-statement.js';
import { dynamicCodeExecutionRule } from './dynamic-code-execution.js';
import { emptyCatchRule } from './empty-catch.js';
import { evalUseRule } from './eval-use.js';
import { hardcodedSecretRule } from './hardcoded-secret.js';
import { timerStringCodeRule } from './timer-string-code.js';

export const RULES = [
  evalUseRule,
  dynamicCodeExecutionRule,
  timerStringCodeRule,
  hardcodedSecretRule,
  emptyCatchRule,
  debuggerStatementRule,
];

export {
  debuggerStatementRule,
  dynamicCodeExecutionRule,
  emptyCatchRule,
  evalUseRule,
  hardcodedSecretRule,
  timerStringCodeRule,
};
