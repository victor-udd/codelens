import {
  formatZodIssues,
  ValidationError,
} from '../errors/validation-error.js';

// Validates before any service or repository call so invalid submissions
// never reach business logic or the database.
export function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return next(new ValidationError(formatZodIssues(result.error.issues)));
    }

    req.validated = result.data;
    return next();
  };
}

export const validate = validateBody;
