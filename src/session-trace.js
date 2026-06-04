/**
 * Structured traces for logout / socket teardown / auth cleanup (no behavior changes).
 */

/**
 * @param {number} [skipFrames]
 * @returns {string|null}
 */
export function captureStack(skipFrames = 2) {
  const err = new Error();
  if (!err.stack) return null;
  const lines = err.stack.split("\n");
  return lines.slice(skipFrames).join("\n") || err.stack;
}

/**
 * @param {import('pino').Logger} logger
 * @param {string} event
 * @param {object} params
 * @param {number} params.clinicId
 * @param {string} params.caller
 * @param {{ socketGenerationId?: number|null }|null|undefined} params.entry
 * @param {Record<string, unknown>} [params.extra]
 */
export function logSessionTrace(logger, event, { clinicId, caller, entry, extra = {} }) {
  logger.info(
    {
      clinic_id: clinicId,
      caller,
      stack: captureStack(3),
      socket_generation_id: entry?.socketGenerationId ?? null,
      timestamp: new Date().toISOString(),
      ...extra,
    },
    event,
  );
}

/**
 * @param {import('pino').Logger} logger
 * @param {object} params
 * @param {number} params.clinicId
 * @param {string} params.caller
 * @param {{ socketGenerationId?: number|null }|null|undefined} params.entry
 * @param {Record<string, unknown>} [params.extra]
 */
export function traceLogout(logger, params) {
  logSessionTrace(logger, "whatsapp.logout.trace", params);
}

/**
 * @param {import('pino').Logger} logger
 * @param {object} params
 * @param {number} params.clinicId
 * @param {string} params.caller
 * @param {{ socketGenerationId?: number|null }|null|undefined} params.entry
 * @param {Record<string, unknown>} [params.extra]
 */
export function traceSocketDestroy(logger, params) {
  logSessionTrace(logger, "whatsapp.socket.destroy.trace", params);
}

/**
 * @param {import('pino').Logger} logger
 * @param {object} params
 * @param {number} params.clinicId
 * @param {string} params.caller
 * @param {{ socketGenerationId?: number|null }|null|undefined} params.entry
 * @param {Record<string, unknown>} [params.extra]
 */
export function traceSessionCleanup(logger, params) {
  logSessionTrace(logger, "whatsapp.session.cleanup.trace", params);
}

/**
 * @param {{ socketGenerationId?: number }} entry
 * @returns {number}
 */
export function nextSocketGenerationId(entry) {
  const next = (entry.socketGenerationId || 0) + 1;
  entry.socketGenerationId = next;
  return next;
}
