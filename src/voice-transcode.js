import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { logVoiceTrace } from "./voice-trace.js";

const execFileAsync = promisify(execFile);

const WHATSAPP_VOICE_MIME = "audio/ogg; codecs=opus";
const WHATSAPP_VOICE_EXT = ".ogg";

/** @type {boolean|null} */
let ffmpegAvailableCache = null;

function ffmpegBin() {
  const custom = String(process.env.FFMPEG_PATH || process.env.WHATSAPP_FFMPEG_PATH || "").trim();
  return custom !== "" ? custom : "ffmpeg";
}

/**
 * @returns {Promise<boolean>}
 */
export async function isFfmpegAvailable() {
  if (ffmpegAvailableCache !== null) {
    return ffmpegAvailableCache;
  }
  try {
    await execFileAsync(ffmpegBin(), ["-version"], {
      timeout: 8000,
      maxBuffer: 512 * 1024,
    });
    ffmpegAvailableCache = true;
  } catch {
    ffmpegAvailableCache = false;
  }
  return ffmpegAvailableCache;
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 */
async function runFfmpegTranscode(inputPath, outputPath) {
  const args = [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-c:a",
    "libopus",
    "-application",
    "voip",
    "-ar",
    "48000",
    "-avoid_negative_ts",
    "make_zero",
    "-f",
    "ogg",
    outputPath,
  ];
  await execFileAsync(ffmpegBin(), args, {
    timeout: Number(process.env.WHATSAPP_VOICE_TRANSCODE_TIMEOUT_MS || 120000),
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * @param {string} mime
 * @param {string} ext
 */
export function shouldTranscodeForVoiceNote(mime, ext) {
  const mimeLower = String(mime || "").toLowerCase();
  const extLower = String(ext || "").toLowerCase();
  if (mimeLower.includes("webm") || extLower === ".webm") {
    return true;
  }
  if (extLower === ".ogg" || extLower === ".opus") {
    return false;
  }
  return true;
}

/**
 * Prepare WhatsApp voice note (OGG/Opus + ptt). Falls back to original on failure.
 *
 * @param {import('pino').Logger} logger
 * @param {Record<string, unknown>} payload
 * @param {string} inputPath
 * @param {string} originalMime
 * @param {string} originalFileName
 * @returns {Promise<{
 *   sendPath: string,
 *   mimetype: string,
 *   ptt: boolean,
 *   cleanupOutput: boolean,
 *   diagnostics: Record<string, unknown>,
 * }>}
 */
export async function prepareVoiceNoteAudio(
  logger,
  payload,
  inputPath,
  originalMime,
  originalFileName,
) {
  const originalExt =
    path.extname(originalFileName || "").toLowerCase() ||
    path.extname(inputPath).toLowerCase() ||
    null;

  const baseDiagnostics = {
    original_mime_type: originalMime || null,
    original_extension: originalExt,
    transcoded_mime_type: null,
    transcoded_extension: null,
    transcoding_success: false,
    transcoded_file_size: 0,
    final_ptt: false,
    transcode_skipped: false,
    fallback_path: false,
  };

  const canUseOggDirect =
    (originalExt === ".ogg" || originalExt === ".opus") &&
    !String(originalMime || "").toLowerCase().includes("webm");

  if (canUseOggDirect && fs.existsSync(inputPath) && fs.statSync(inputPath).size > 0) {
    const size = fs.statSync(inputPath).size;
    const diagnostics = {
      ...baseDiagnostics,
      transcode_skipped: true,
      transcoding_success: true,
      transcoded_mime_type: WHATSAPP_VOICE_MIME,
      transcoded_extension: WHATSAPP_VOICE_EXT,
      transcoded_file_size: size,
      final_ptt: true,
    };
    logVoiceTrace(logger, "whatsapp.voice.transcode.success", payload, {
      ...diagnostics,
      note: "input_already_ogg_opus",
    });
    return {
      sendPath: inputPath,
      mimetype: WHATSAPP_VOICE_MIME,
      ptt: true,
      cleanupOutput: false,
      diagnostics,
    };
  }

  if (!shouldTranscodeForVoiceNote(originalMime, originalExt)) {
    const diagnostics = {
      ...baseDiagnostics,
      transcode_skipped: true,
      transcoding_success: true,
      transcoded_mime_type: WHATSAPP_VOICE_MIME,
      transcoded_extension: WHATSAPP_VOICE_EXT,
      transcoded_file_size: fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0,
      final_ptt: true,
    };
    return {
      sendPath: inputPath,
      mimetype: WHATSAPP_VOICE_MIME,
      ptt: true,
      cleanupOutput: false,
      diagnostics,
    };
  }

  if (!(await isFfmpegAvailable())) {
    logVoiceTrace(logger, "whatsapp.voice.transcode.error", payload, {
      ...baseDiagnostics,
      error: "ffmpeg_not_available",
      fallback_path: true,
    });
    return legacyFallback(inputPath, originalMime, originalExt, baseDiagnostics);
  }

  const outputPath = path.join(
    os.tmpdir(),
    `wa-voice-${crypto.randomBytes(8).toString("hex")}${WHATSAPP_VOICE_EXT}`,
  );

  logVoiceTrace(logger, "whatsapp.voice.transcode.start", payload, {
    original_mime_type: originalMime,
    original_extension: originalExt,
    input_path: inputPath,
    output_path: outputPath,
    ffmpeg: ffmpegBin(),
  });

  try {
    await runFfmpegTranscode(inputPath, outputPath);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error("ffmpeg produced empty output");
    }
    const transcodedSize = fs.statSync(outputPath).size;
    const diagnostics = {
      ...baseDiagnostics,
      transcoding_success: true,
      transcoded_mime_type: WHATSAPP_VOICE_MIME,
      transcoded_extension: WHATSAPP_VOICE_EXT,
      transcoded_file_size: transcodedSize,
      final_ptt: true,
    };
    logVoiceTrace(logger, "whatsapp.voice.transcode.success", payload, diagnostics);
    return {
      sendPath: outputPath,
      mimetype: WHATSAPP_VOICE_MIME,
      ptt: true,
      cleanupOutput: true,
      diagnostics,
    };
  } catch (err) {
    logVoiceTrace(logger, "whatsapp.voice.transcode.error", payload, {
      ...baseDiagnostics,
      error: err?.message || String(err),
      fallback_path: true,
    });
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch {
      /* ignore */
    }
    return legacyFallback(inputPath, originalMime, originalExt, baseDiagnostics);
  }
}

/**
 * @param {string} inputPath
 * @param {string} originalMime
 * @param {string|null} originalExt
 * @param {Record<string, unknown>} baseDiagnostics
 */
function legacyFallback(inputPath, originalMime, originalExt, baseDiagnostics) {
  const mimeLower = String(originalMime || "").toLowerCase();
  const isWebm =
    mimeLower.includes("webm") || String(originalExt || "").toLowerCase() === ".webm";
  const diagnostics = {
    ...baseDiagnostics,
    transcoding_success: false,
    fallback_path: true,
    final_ptt: !isWebm,
  };
  return {
    sendPath: inputPath,
    mimetype: originalMime || "audio/webm",
    ptt: !isWebm,
    cleanupOutput: false,
    diagnostics,
  };
}
