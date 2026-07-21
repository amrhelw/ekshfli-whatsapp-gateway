/**
 * Baileys profile picture fetch with short in-memory TTL cache.
 *
 * Privacy-hidden contacts → { url: null, unavailable: true, reason: "privacy" }
 * Transient failures → { url: null, unavailable: false } so callers retry.
 */

import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" }).child({ module: "profile-photo" });

const SUCCESS_TTL_MS = Number(process.env.WHATSAPP_PROFILE_PHOTO_CACHE_MS || 6 * 60 * 60 * 1000);
const MISS_TTL_MS = Number(process.env.WHATSAPP_PROFILE_PHOTO_MISS_CACHE_MS || 30 * 60 * 1000);
const TRANSIENT_TTL_MS = Number(process.env.WHATSAPP_PROFILE_PHOTO_TRANSIENT_CACHE_MS || 2 * 60 * 1000);

/** @type {Map<string, { url: string|null, unavailable: boolean, at: number, ttl: number, reason?: string }>} */
const cache = new Map();

function cacheKey(clinicId, jid) {
  return `${clinicId}|${String(jid || "").trim().toLowerCase()}`;
}

function isPrivacyError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  const status = err?.output?.statusCode || err?.status || err?.statusCode || null;
  if (status === 404 || status === 401 || status === 403) return true;
  return (
    msg.includes("not-authorized") ||
    msg.includes("item-not-found") ||
    msg.includes("forbidden") ||
    msg.includes("privacy") ||
    msg.includes("404")
  );
}

function isTransientError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("rate") ||
    msg.includes("overloaded") ||
    msg.includes("econnreset") ||
    msg.includes("socket") ||
    msg.includes("temporarily")
  );
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket|null|undefined} sock
 * @param {string} jid
 * @param {{ force?: boolean, clinicId?: number|string }} [opts]
 * @returns {Promise<{ url: string|null, unavailable: boolean, from_cache: boolean, reason?: string, jid?: string }>}
 */
export async function resolveProfilePictureUrl(sock, jid, opts = {}) {
  const force = Boolean(opts.force);
  const clinicId = opts.clinicId ?? 0;
  const normalizedJid = String(jid || "").trim();
  if (!normalizedJid || !sock || typeof sock.profilePictureUrl !== "function") {
    logger.warn(
      { clinic_id: clinicId, jid: normalizedJid || null, has_sock: Boolean(sock) },
      "whatsapp.profile_picture.skip_invalid",
    );
    return {
      url: null,
      unavailable: false,
      from_cache: false,
      reason: "invalid_jid_or_sock",
      jid: normalizedJid || null,
    };
  }

  const key = cacheKey(clinicId, normalizedJid);
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.ttl || SUCCESS_TTL_MS)) {
      logger.info(
        {
          clinic_id: clinicId,
          jid: normalizedJid,
          url: hit.url ? String(hit.url).slice(0, 120) : null,
          unavailable: hit.unavailable,
          from_cache: true,
          reason: hit.reason || null,
        },
        "whatsapp.profile_picture.cache_hit",
      );
      return {
        url: hit.url,
        unavailable: hit.unavailable,
        from_cache: true,
        reason: hit.reason,
        jid: normalizedJid,
      };
    }
  } else {
    cache.delete(key);
  }

  const tryFetch = async (targetJid, type) => {
    const url = await sock.profilePictureUrl(targetJid, type);
    return url && String(url).trim() ? String(url).trim() : null;
  };

  try {
    // Prefer full "image" (Refresh Contact contract), then "preview" fallback.
    let clean = null;
    let usedType = "image";
    try {
      clean = await tryFetch(normalizedJid, "image");
    } catch (imageErr) {
      try {
        clean = await tryFetch(normalizedJid, "preview");
        usedType = "preview";
      } catch (previewErr) {
        throw imageErr || previewErr;
      }
    }

    const entry = {
      url: clean,
      unavailable: !clean,
      at: Date.now(),
      ttl: clean ? SUCCESS_TTL_MS : MISS_TTL_MS,
      reason: clean ? `ok:${usedType}` : "empty_url",
    };
    cache.set(key, entry);

    logger.info(
      {
        clinic_id: clinicId,
        jid: normalizedJid,
        url: clean ? clean.slice(0, 160) : null,
        unavailable: entry.unavailable,
        from_cache: false,
        type: usedType,
      },
      "whatsapp.profile_picture.fetched",
    );

    return {
      url: entry.url,
      unavailable: entry.unavailable,
      from_cache: false,
      reason: entry.reason,
      jid: normalizedJid,
    };
  } catch (err) {
    const privacy = isPrivacyError(err);
    const transient = !privacy && isTransientError(err);
    const entry = {
      url: null,
      unavailable: privacy,
      at: Date.now(),
      ttl: privacy ? MISS_TTL_MS : TRANSIENT_TTL_MS,
      reason: privacy ? "privacy" : transient ? "transient" : "error",
    };
    cache.set(key, entry);

    logger.warn(
      {
        clinic_id: clinicId,
        jid: normalizedJid,
        url: null,
        unavailable: entry.unavailable,
        privacy,
        transient,
        error: String(err?.message || err || "unknown"),
      },
      "whatsapp.profile_picture.fetch_failed",
    );

    return {
      url: entry.url,
      unavailable: entry.unavailable,
      from_cache: false,
      reason: entry.reason,
      jid: normalizedJid,
    };
  }
}

/**
 * Try phone JID first, then fallback JIDs (LID / alt).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string[]} jids
 * @param {{ force?: boolean, clinicId?: number|string }} [opts]
 */
export async function resolveProfilePictureUrlCandidates(sock, jids, opts = {}) {
  const seen = new Set();
  let last = { url: null, unavailable: false, from_cache: false, reason: "no_jid" };
  for (const raw of jids) {
    const jid = String(raw || "").trim();
    if (!jid || seen.has(jid.toLowerCase())) continue;
    seen.add(jid.toLowerCase());
    const result = await resolveProfilePictureUrl(sock, jid, opts);
    last = result;
    if (result.url) return result;
    if (result.unavailable) {
      continue;
    }
  }
  return last;
}

export function invalidateProfilePictureCache(clinicId, jid) {
  cache.delete(cacheKey(clinicId, jid));
}
