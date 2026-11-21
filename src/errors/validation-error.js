// Carries field-level Zod issues through the existing Express error pipeline
// without exposing raw input values in logs or responses.
export class ValidationError extends Error {
  constructor(details, message = 'Invalid review submission') {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = 'VALIDATION_ERROR';
    this.details = details;
  }
}

export function formatZodIssues(issues) {
  return issues.flatMap((issue) => {
    const detail = {
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    };

    // Zod reports unrecognized keys at the object root; expose each key so
    // clients can point at the offending field.
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        ...detail,
        path: key,
        message: `Unrecognized key: "${key}"`,
      }));
    }

    return [detail];
  });
}
