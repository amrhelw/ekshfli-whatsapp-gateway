/**
 * Single source of truth: Baileys msg.message → inbound webhook text DTO.
 *
 * normalizeIncomingMessage() must be used for all inbound parsing.
 *
 * Regression (0ab68f1): blindly preferring Baileys extractMessageContent() can
 * replace real conversation / extendedTextMessage text with an empty
 * buttons/template stub ({ conversation: "" }), which Laravel stores empty and
 * the Admin UI renders as "—". Prefer manual unwrap + real text carriers first.
 */

import { extractMessageContent } from "@whiskeysockets/baileys";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** Future-proof / nested wrappers WhatsApp may add around real content. */
const FUTURE_PROOF_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
  "deviceSentMessage",
  "newsletterMessage",
  "associatedChildMessage",
  "groupMentionedMessage",
  "botInvokeMessage",
  "lottieStickerMessage",
  "statusMentionMessage",
  "groupStatusMentionMessage",
  "groupStatusMessage",
  "pollCreationOptionImageMessage",
  "limitSharingMessage",
  "botTaskMessage",
  "questionMessage",
];

/**
 * Manually unwrap nested message wrappers (does NOT call Baileys extract).
 * @param {object|null|undefined} message
 * @returns {object|null}
 */
export function unwrapMessageLayers(message) {
  if (!message || typeof message !== "object") return null;

  let inner = message;
  for (let i = 0; i < 10; i += 1) {
    let next = null;
    for (const key of FUTURE_PROOF_KEYS) {
      if (inner?.[key]?.message && typeof inner[key].message === "object") {
        next = inner[key].message;
        break;
      }
    }
    if (!next && inner?.message && typeof inner.message === "object" && !isLeafContent(inner)) {
      // Rare: { message: { conversation } } envelope
      next = inner.message;
    }
    if (!next) break;
    inner = next;
  }

  return inner && typeof inner === "object" ? inner : null;
}

function isLeafContent(node) {
  if (!node || typeof node !== "object") return false;
  return Boolean(
    node.conversation != null ||
      node.extendedTextMessage ||
      node.imageMessage ||
      node.videoMessage ||
      node.audioMessage ||
      node.documentMessage ||
      node.stickerMessage ||
      node.buttonsResponseMessage ||
      node.listResponseMessage ||
      node.templateButtonReplyMessage ||
      node.interactiveResponseMessage ||
      node.buttonsMessage ||
      node.templateMessage ||
      node.reactionMessage,
  );
}

function str(value) {
  if (value == null) return null;
  try {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      const s = value.toString("utf8").trim();
      return s === "" ? null : s;
    }
    if (value instanceof Uint8Array) {
      const s = Buffer.from(value).toString("utf8").trim();
      return s === "" ? null : s;
    }
  } catch {
    /* fall through */
  }
  if (typeof value === "object") {
    if (value.type === "Buffer" && Array.isArray(value.data)) {
      try {
        const s = Buffer.from(value.data).toString("utf8").trim();
        return s === "" ? null : s;
      } catch {
        return null;
      }
    }
    if (typeof value.text === "string" || typeof value.text === "object") return str(value.text);
    if (typeof value.conversation === "string" || typeof value.conversation === "object") {
      return str(value.conversation);
    }
    return null;
  }
  const s = String(value).trim();
  if (s === "" || /^\[(message|text|media|unknown|empty)\]$/i.test(s) || s === "—" || s === "-") {
    return null;
  }
  return s;
}

function firstText(...candidates) {
  for (const c of candidates) {
    const s = str(c);
    if (s) return s;
  }
  return null;
}

function mediaMetaFromProto(m) {
  if (!m || typeof m !== "object") return null;
  return {
    mime_type: m.mimetype || null,
    filename: m.fileName || m.title || null,
    size_bytes: m.fileLength != null ? Number(m.fileLength) : null,
    sha256: null,
    direct_path: m.directPath || null,
    height: m.height != null ? Number(m.height) : null,
    width: m.width != null ? Number(m.width) : null,
    seconds: m.seconds != null ? Number(m.seconds) : null,
  };
}

/**
 * Score whether a proto node has primary user-visible text (not template stubs).
 */
function primaryTextFromInner(inner) {
  if (!inner || typeof inner !== "object") return null;
  return firstText(
    inner.conversation,
    inner.extendedTextMessage?.text,
    inner.imageMessage?.caption,
    inner.videoMessage?.caption,
    inner.documentMessage?.caption,
    inner.documentMessage?.title,
    inner.buttonsResponseMessage?.selectedDisplayText,
    inner.buttonsResponseMessage?.selectedButtonId,
    inner.listResponseMessage?.title,
    inner.listResponseMessage?.description,
    inner.templateButtonReplyMessage?.selectedDisplayText,
    inner.interactiveResponseMessage?.body?.text,
    inner.buttonsMessage?.contentText,
    inner.reactionMessage?.text,
    inner.locationMessage?.name,
    inner.locationMessage?.address,
    inner.liveLocationMessage?.caption,
    inner.contactMessage?.displayName,
    inner.contactsArrayMessage?.displayName,
  );
}

/**
 * Pick the best inner content candidate.
 * Never let Baileys extractMessageContent overwrite real Arabic/English text
 * with an empty buttons/template conversation stub.
 */
function resolveInnerContent(message) {
  const manual = unwrapMessageLayers(message);

  let extracted = null;
  try {
    extracted = extractMessageContent(message) || null;
  } catch {
    extracted = null;
  }
  if (extracted) {
    extracted = unwrapMessageLayers(extracted) || extracted;
  }

  const manualText = primaryTextFromInner(manual);
  const extractedText = primaryTextFromInner(extracted);

  if (manualText) {
    // Keep manual when extract is empty or only a different/weaker stub.
    if (!extractedText || extractedText === manualText) {
      return manual;
    }
    // Real conversation/extendedText always wins over template/buttons extract.
    if (manual?.conversation != null || manual?.extendedTextMessage) {
      return manual;
    }
  }

  if (extractedText) {
    return extracted;
  }

  // extract returned { conversation: "" } — discard in favor of manual / raw.
  if (extracted && str(extracted.conversation) == null && extracted.conversation === "") {
    return manual || message;
  }

  return manual || extracted || message || null;
}

function deepFindReadableText(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  const preferred = [
    "conversation",
    "text",
    "caption",
    "selectedDisplayText",
    "title",
    "description",
    "contentText",
    "footerText",
    "displayName",
    "name",
    "address",
    "comment",
  ];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const s = str(node[key]);
      if (s) return s;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    // Skip heavy / non-text binary-ish fields
    if (
      /thumbnail|mediaKey|fileSha|fileEnc|jpeg|wave|directPath/i.test(key) ||
      typeof value === "function"
    ) {
      continue;
    }
    if (value && typeof value === "object") {
      const found = deepFindReadableText(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function logParseFailure(message, inner, result) {
  const safeKeys = (obj) =>
    obj && typeof obj === "object" ? Object.keys(obj).slice(0, 40) : [];
  logger.warn(
    {
      message_keys: safeKeys(message),
      inner_keys: safeKeys(inner),
      message_type: result.message_type,
      raw_preview: summarizeRawForLog(message),
    },
    "whatsapp.inbound.parse_empty_text",
  );
}

function summarizeRawForLog(message, depth = 0) {
  if (message == null || depth > 4) return null;
  if (typeof message !== "object") {
    const s = str(message);
    return s ? s.slice(0, 120) : typeof message;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(message)) {
    return { buffer_utf8_preview: message.toString("utf8").slice(0, 80), len: message.length };
  }
  const out = {};
  for (const [k, v] of Object.entries(message)) {
    if (/thumbnail|mediaKey|fileSha|fileEnc|jpeg|wave/i.test(k)) {
      out[k] = "[omitted]";
      continue;
    }
    if (v && typeof v === "object") {
      out[k] = summarizeRawForLog(v, depth + 1);
    } else {
      const s = str(v);
      out[k] = s ? s.slice(0, 80) : v;
    }
  }
  return out;
}

/**
 * @param {object|null|undefined} message proto.IMessage (raw msg.message)
 * @returns {{
 *   message_type: string,
 *   text: string|null,
 *   caption: string|null,
 *   media: object|null,
 *   quoted_message_id: string|null,
 *   display_text: string|null
 * }}
 */
export function normalizeIncomingMessage(message) {
  const inner = resolveInnerContent(message);
  if (!inner) {
    const empty = {
      message_type: "unknown",
      text: null,
      caption: null,
      media: null,
      quoted_message_id: null,
      display_text: null,
    };
    logParseFailure(message, null, empty);
    return empty;
  }

  const contextInfo =
    inner.extendedTextMessage?.contextInfo ||
    inner.imageMessage?.contextInfo ||
    inner.videoMessage?.contextInfo ||
    inner.audioMessage?.contextInfo ||
    inner.documentMessage?.contextInfo ||
    inner.stickerMessage?.contextInfo ||
    inner.buttonsResponseMessage?.contextInfo ||
    inner.listResponseMessage?.contextInfo ||
    inner.templateButtonReplyMessage?.contextInfo ||
    null;
  const quotedMessageId = contextInfo?.stanzaId ? String(contextInfo.stanzaId) : null;

  const conversationText = firstText(inner.conversation, inner.extendedTextMessage?.text);
  if (conversationText) {
    return {
      message_type: "text",
      text: conversationText,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: conversationText,
    };
  }

  if (inner.imageMessage) {
    const caption = firstText(inner.imageMessage.caption);
    return {
      message_type: "image",
      text: caption,
      caption,
      media: mediaMetaFromProto(inner.imageMessage),
      quoted_message_id: quotedMessageId,
      display_text: caption,
    };
  }

  if (inner.videoMessage || inner.ptvMessage) {
    const mediaNode = inner.videoMessage || inner.ptvMessage;
    const caption = firstText(mediaNode.caption);
    return {
      message_type: "video",
      text: caption,
      caption,
      media: mediaMetaFromProto(mediaNode),
      quoted_message_id: quotedMessageId,
      display_text: caption,
    };
  }

  if (inner.audioMessage) {
    return {
      message_type: "audio",
      text: null,
      caption: null,
      media: mediaMetaFromProto(inner.audioMessage),
      quoted_message_id: quotedMessageId,
      display_text: null,
    };
  }

  if (inner.documentMessage) {
    const caption = firstText(inner.documentMessage.caption, inner.documentMessage.title);
    return {
      message_type: "document",
      text: caption,
      caption,
      media: {
        ...mediaMetaFromProto(inner.documentMessage),
        filename: inner.documentMessage.fileName || inner.documentMessage.title || null,
      },
      quoted_message_id: quotedMessageId,
      display_text: caption,
    };
  }

  if (inner.stickerMessage) {
    return {
      message_type: "sticker",
      text: null,
      caption: null,
      media: mediaMetaFromProto(inner.stickerMessage),
      quoted_message_id: quotedMessageId,
      display_text: null,
    };
  }

  if (inner.locationMessage || inner.liveLocationMessage) {
    const loc = inner.locationMessage || inner.liveLocationMessage;
    const text = firstText(loc?.name, loc?.address, loc?.comment, loc?.caption);
    return {
      message_type: "location",
      text,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: text,
    };
  }

  if (inner.contactMessage || inner.contactsArrayMessage) {
    const text = firstText(
      inner.contactMessage?.displayName,
      inner.contactsArrayMessage?.displayName,
    );
    return {
      message_type: inner.contactsArrayMessage ? "contacts" : "contact",
      text,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: text,
    };
  }

  if (inner.reactionMessage) {
    const text = firstText(inner.reactionMessage.text);
    return {
      message_type: "reaction",
      text,
      caption: null,
      media: null,
      quoted_message_id: inner.reactionMessage.key?.id
        ? String(inner.reactionMessage.key.id)
        : quotedMessageId,
      display_text: text,
    };
  }

  if (inner.buttonsResponseMessage) {
    const text = firstText(
      inner.buttonsResponseMessage.selectedDisplayText,
      inner.buttonsResponseMessage.selectedButtonId,
    );
    return {
      message_type: "text",
      text,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: text,
    };
  }

  if (inner.listResponseMessage) {
    const text = firstText(
      inner.listResponseMessage.title,
      inner.listResponseMessage.description,
      inner.listResponseMessage.singleSelectReply?.selectedRowId,
    );
    return {
      message_type: "text",
      text,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: text,
    };
  }

  if (inner.templateButtonReplyMessage) {
    const text = firstText(
      inner.templateButtonReplyMessage.selectedDisplayText,
      inner.templateButtonReplyMessage.selectedId,
    );
    return {
      message_type: "text",
      text,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: text,
    };
  }

  if (inner.interactiveResponseMessage) {
    const ir = inner.interactiveResponseMessage;
    const text = firstText(
      ir.body?.text,
      ir.nativeFlowResponseMessage?.paramsJson,
      ir.quotedMessage?.conversation,
    );
    return {
      message_type: "text",
      text,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: text,
    };
  }

  if (inner.buttonsMessage) {
    const text = firstText(inner.buttonsMessage.contentText, inner.buttonsMessage.footerText);
    if (text) {
      return {
        message_type: "text",
        text,
        caption: null,
        media: null,
        quoted_message_id: quotedMessageId,
        display_text: text,
      };
    }
  }

  // Protocol / stubs without user content
  const hasUserContent = Boolean(
    (inner.conversation != null && str(inner.conversation)) ||
      inner.extendedTextMessage ||
      inner.imageMessage ||
      inner.videoMessage ||
      inner.ptvMessage ||
      inner.audioMessage ||
      inner.documentMessage ||
      inner.stickerMessage ||
      inner.locationMessage ||
      inner.liveLocationMessage ||
      inner.contactMessage ||
      inner.contactsArrayMessage ||
      inner.reactionMessage ||
      inner.buttonsResponseMessage ||
      inner.templateButtonReplyMessage ||
      inner.listResponseMessage ||
      inner.interactiveResponseMessage ||
      (inner.buttonsMessage && firstText(inner.buttonsMessage.contentText)),
  );

  if (
    !hasUserContent &&
    (inner.protocolMessage ||
      inner.senderKeyDistributionMessage ||
      inner.messageContextInfo ||
      Object.keys(inner).length === 0)
  ) {
    return {
      message_type: "system",
      text: null,
      caption: null,
      media: null,
      quoted_message_id: null,
      display_text: null,
    };
  }

  const deepText = deepFindReadableText(inner) || deepFindReadableText(message);
  if (deepText) {
    return {
      message_type: "text",
      text: deepText,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: deepText,
    };
  }

  const unknown = {
    message_type: "unknown",
    text: null,
    caption: null,
    media: null,
    quoted_message_id: quotedMessageId,
    display_text: null,
  };
  logParseFailure(message, inner, unknown);
  return unknown;
}

/** @deprecated Use normalizeIncomingMessage — kept for existing imports. */
export function extractNormalizedMessageContent(message) {
  return normalizeIncomingMessage(message);
}

/**
 * JSON-safe copy of Baileys message for Laravel fallback / diagnostics.
 * Omits large binary fields; preserves UTF-8 text carriers.
 */
export function serializeMessageForWebhook(message) {
  if (!message || typeof message !== "object") return null;
  try {
    return JSON.parse(
      JSON.stringify(message, (key, value) => {
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
          if (value.length <= 4096) {
            return { type: "Buffer", data: Array.from(value) };
          }
          return { type: "Buffer", omitted: value.length };
        }
        if (value instanceof Uint8Array) {
          if (value.length <= 4096) {
            return { type: "Buffer", data: Array.from(value) };
          }
          return { type: "Buffer", omitted: value.length };
        }
        if (/thumbnail|jpegThumbnail|waveforms/i.test(key) && value) {
          return "[omitted]";
        }
        return value;
      }),
    );
  } catch {
    return null;
  }
}
