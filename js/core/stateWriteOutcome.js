// @ts-check
// The same prefix is returned by the desktop state writer after a replacement
// may have happened. It is deliberately separate from ordinary pre-write errors.
const UNCERTAIN_PREFIX = 'TF_STATE_WRITE_UNCERTAIN:';
const UNCHANGED_PREFIX = 'TF_STATE_WRITE_UNCHANGED:';

/** @param {unknown} error */
function errorMessage(error) {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : '';
}

/** @param {unknown} error */
export function isUncertainStateWrite(error) {
  return errorMessage(error).startsWith(UNCERTAIN_PREFIX);
}

export function uncertainStateWriteError() {
  return new Error(`${UNCERTAIN_PREFIX} Состояние могло измениться, но подтверждение не получено`);
}

/**
 * A native command can finish writing even if its IPC response is lost. Only
 * an explicit pre-replacement result from the command is safe to retry.
 * @param {unknown} error
 */
export function classifyNativeStateWriteFailure(error) {
  const message = errorMessage(error);
  if (message.startsWith(UNCHANGED_PREFIX)) return new Error(message.slice(UNCHANGED_PREFIX.length).trim());
  return uncertainStateWriteError();
}
