/**
 * Runtime lifecycle tracer for WhatsApp connection start path.
 * Exposed via GET /health — no secrets.
 */

/** @type {Array<Record<string, unknown>>} */
const stages = [];
const MAX = 120;

/** @type {Array<Record<string, unknown>>} */
const httpAuth = [];
const HTTP_MAX = 40;

let lastAbort = null;

export function lifecycleEnter(stage, fields = {}) {
  const row = {
    at: new Date().toISOString(),
    stage,
    phase: "ENTER",
    ...sanitize(fields),
  };
  push(stages, row, MAX);
  console.log(`[LIFECYCLE] ENTER ${stage}`, JSON.stringify(sanitize(fields)));
  return Date.now();
}

export function lifecycleExit(stage, startedAt, fields = {}) {
  const duration_ms = typeof startedAt === "number" ? Date.now() - startedAt : null;
  const row = {
    at: new Date().toISOString(),
    stage,
    phase: "EXIT",
    duration_ms,
    ...sanitize(fields),
  };
  push(stages, row, MAX);
  console.log(
    `[LIFECYCLE] EXIT ${stage}`,
    JSON.stringify({ duration_ms, ...sanitize(fields) }),
  );
  return row;
}

export function lifecycleException(stage, startedAt, err, fields = {}) {
  const duration_ms = typeof startedAt === "number" ? Date.now() - startedAt : null;
  const exception = {
    message: err?.message || String(err),
    name: err?.name || null,
    stack: err?.stack ? String(err.stack).slice(0, 2000) : null,
  };
  const row = {
    at: new Date().toISOString(),
    stage,
    phase: "EXCEPTION",
    duration_ms,
    exception,
    ...sanitize(fields),
  };
  push(stages, row, MAX);
  lastAbort = {
    at: row.at,
    stage,
    reason: "exception",
    exception,
    ...sanitize(fields),
  };
  console.error(`[LIFECYCLE] EXCEPTION ${stage}`, JSON.stringify(row));
  return row;
}

export function lifecycleAbort(stage, condition, fields = {}) {
  const row = {
    at: new Date().toISOString(),
    stage,
    phase: "ABORT",
    condition,
    ...sanitize(fields),
  };
  push(stages, row, MAX);
  lastAbort = {
    at: row.at,
    stage,
    reason: "abort",
    condition,
    ...sanitize(fields),
  };
  console.error(`[LIFECYCLE] ABORT ${stage}`, JSON.stringify(row));
  return row;
}

export function recordHttpAuth(fields = {}) {
  const row = {
    at: new Date().toISOString(),
    ...sanitize(fields),
  };
  push(httpAuth, row, HTTP_MAX);
  if (fields.rejected) {
    lastAbort = {
      at: row.at,
      stage: "http_auth_middleware",
      reason: "abort",
      condition: fields.condition || "header !== TOKEN",
      ...sanitize(fields),
    };
  }
  console.log("[LIFECYCLE] HTTP_AUTH", JSON.stringify(row));
}

export function getLifecycleSnapshot() {
  return {
    last_abort: lastAbort,
    stages: stages.slice(-80),
    http_auth: httpAuth.slice(-30),
  };
}

function push(arr, row, max) {
  arr.push(row);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function sanitize(fields) {
  const out = { ...fields };
  for (const key of Object.keys(out)) {
    const lk = key.toLowerCase();
    if (
      lk.includes("token") ||
      lk.includes("secret") ||
      lk.includes("password") ||
      lk.includes("authorization")
    ) {
      const v = out[key];
      if (v == null || v === "") out[key] = null;
      else if (typeof v === "string") out[key] = `[set len=${v.length}]`;
      else out[key] = "[set]";
    }
  }
  return out;
}
