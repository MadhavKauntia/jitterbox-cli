// Errors carry the exit code the CLI ends with, so scripts and agents can react without parsing text.
//   1 unexpected · 2 usage · 3 report failed · 4 no traffic · 5 lease timeout
//   6 not signed in / bad token · 7 not found · 8 not allowed (role or plan limit) · 9 conflict

export class CliError extends Error {
  constructor(message, { exitCode = 1, code = "error", hint, fields } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
    this.hint = hint;
    this.fields = fields;
  }
}

export class UsageError extends CliError {
  constructor(message, hint) {
    super(message, { exitCode: 2, code: "usage", hint });
  }
}

/** Maps an API error response to a CliError with the right exit code. */
export function apiError(status, body, fallback) {
  const err = body?.error ?? {};
  const message = err.message ?? fallback;
  const exitCode = status === 401 ? 6 : status === 404 ? 7 : status === 403 ? 8 : status === 409 ? 9 : status === 400 ? 2 : 1;
  const hint =
    status === 401
      ? "Run `jitterbox login`, or set JITTERBOX_TOKEN."
      : err.code === "plan_limit"
        ? "This is a beta limit. Remove something, or use another project."
        : status === 403 && /^API tokens can only/.test(message ?? "")
          ? "That needs a personal token: run `jitterbox login`, or set JITTERBOX_TOKEN to a jbp_… token."
          : undefined;
  return new CliError(message, { exitCode, code: err.code ?? `http_${status}`, hint, fields: err.fields });
}
