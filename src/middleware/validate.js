import {
  formatZodIssues,
  ValidationError,
} from '../errors/validation-error.js';

function validateSource(source, target, schema, message) {
  // Validates before any service or repository call so invalid input never
  // reaches business logic or the database.
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return next(new ValidationError(formatZodIssues(result.error.issues), message));
    }

    req[target] = result.data;
    return next();
  };
}

export const validateBody = (schema) =>
  validateSource('body', 'validated', schema, 'Invalid review submission');

export const validateParams = (schema) =>
  validateSource(
    'params',
    'validatedParams',
    schema,
    'Invalid request parameters',
  );

export const validateQuery = (schema) =>
  validateSource('query', 'validatedQuery', schema, 'Invalid query parameters');

export const validate = validateBody;
