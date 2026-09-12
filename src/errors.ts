/**
 * Error-exit helpers: one formatter replacing the
 * `error instanceof Error ? error.message : String(error)` boilerplate that
 * used to repeat across the plugin, plus the stack suffix for error-level
 * log points.
 * @module dsh-onebot/errors
 */

/**
 * Describe any thrown value as a log-safe string: the Error message (or the
 * stringified value), with the `cause` chain appended in parentheses.
 * @param error - the thrown value.
 * @param depth - internal recursion guard for the cause chain (max 5 links).
 * @returns the single description string.
 */
export function describeError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  const causeText = cause !== undefined && depth < 5 ? ' (cause: ' + describeError(cause, depth + 1) + ')' : ''
  return error.message + causeText
}

/**
 * The stack suffix for error-level log points: '\n' + stack for real Errors
 * (warn/debug callers just concatenate describeError), '' otherwise.
 * @param error - the thrown value.
 * @returns the stack suffix (possibly empty).
 */
export function errorStack(error: unknown): string {
  return error instanceof Error && typeof error.stack === 'string' ? '\n' + error.stack : ''
}
