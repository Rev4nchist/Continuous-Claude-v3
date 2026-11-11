// One error type for every non-zero exit. main() turns it into a message on stderr and an exit code.
// Codes: 1 check failed, 2 usage, 3 refused, 5 a contract module is missing.

export class ExitError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'ExitError';
    this.exitCode = exitCode;
  }
}

export const usageError = (message) => new ExitError(2, message);
export const refused = (message) => new ExitError(3, message);
