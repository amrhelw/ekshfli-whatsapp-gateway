/**
 * Centralized WhatsApp message content extraction (Baileys → webhook DTO).
 * Unwraps ephemeral/view-once/edited wrappers and reads every common text carrier.
 */

import { extractMessageContent } from "@whiskeysockets/baileys";

/**
 * @param {object|null|undefined} message proto.IMessage
 * @returns {object|null}
 */
export function unwrapMessageLayers(message) {
  if (!message || typeof message !== "object") return null;

  // Prefer Baileys normalize/extract (ephemeral, view once, templates, buttons).
  let inner = null;
  try {
    inner = extractMessageContent(message) || null;
  } catch {
    inner = null;
  }

  if (!inner) {
    inner = message;
  }

  // Extra wrappers Baileys extract sometimes skips.
  for (let i = 0; i < 6; i += 1) {
    if (inner?.ephemeralMessage?.message) {
      inner = inner.ephemeralMessage.message;
      continue;
    }
    if (inner?.viewOnceMessage?.message) {
      inner = inner.viewOnceMessage.message;
      continue;
    }
    if (inner?.viewOnceMessageV2?.message) {
      inner = inner.viewOnceMessageV2.message;
      continue;
    }
    if (inner?.viewOnceMessageV2Extension?.message) {
      inner = inner.viewOnceMessageV2Extension.message;
      continue;
    }
    if (inner?.documentWithCaptionMessage?.message) {
      inner = inner.documentWithCaptionMessage.message;
      continue;
    }
    if (inner?.editedMessage?.message) {
      inner = inner.editedMessage.message;
      continue;
    }
    if (inner?.deviceSentMessage?.message) {
      inner = inner.deviceSentMessage.message;
      continue;
    }
    break;
  }

  return inner && typeof inner === "object" ? inner : null;
}

function str(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
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
export function extractNormalizedMessageContent(message) {
  const inner = unwrapMessageLayers(message);
  if (!inner) {
    return {
      message_type: "unknown",
      text: null,
      caption: null,
      media: null,
      quoted_message_id: null,
      display_text: null,
    };
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

  // Plain / extended text
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

  if (inner.videoMessage) {
    const caption = firstText(inner.videoMessage.caption);
    return {
      message_type: "video",
      text: caption,
      caption,
      media: mediaMetaFromProto(inner.videoMessage),
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
    const text = firstText(loc?.name, loc?.address, loc?.comment);
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

  // Interactive replies
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
    return {
      message_type: "text",
      text,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
      display_text: text,
    };
  }

  // Protocol / stubs without user content
  const hasUserContent = Boolean(
    inner.conversation ||
      inner.extendedTextMessage ||
      inner.imageMessage ||
      inner.videoMessage ||
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
      inner.buttonsMessage,
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

  return {
    message_type: "unknown",
    text: null,
    caption: null,
    media: null,
    quoted_message_id: quotedMessageId,
    display_text: null,
  };
}
