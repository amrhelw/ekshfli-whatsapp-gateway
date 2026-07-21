/**
 * Regression tests for normalizeIncomingMessage (Arabic "—" bug from 0ab68f1).
 * Run: node scripts/test-normalize-incoming-message.mjs
 */
import assert from "node:assert/strict";
import {
  normalizeIncomingMessage,
  serializeMessageForWebhook,
} from "../src/message-content.js";

const ar = "مرحبا بكم في العيادة";
const mixed = "مرحبا Amr 👋 tomorrow";
const longAr = "مرحبا ".repeat(80).trim();

function expectText(label, message, expected) {
  const n = normalizeIncomingMessage(message);
  assert.equal(n.text, expected, `${label}: text`);
  assert.equal(n.display_text, expected, `${label}: display_text`);
  assert.equal(n.message_type, "text", `${label}: type`);
  console.log(`✓ ${label}`);
}

// Core regression: Baileys extractMessageContent wiped conversation
expectText(
  "arabic + empty buttonsMessage (0ab68f1 regression)",
  { conversation: ar, buttonsMessage: { contentText: "" } },
  ar,
);

expectText(
  "arabic extendedText + empty templateMessage",
  {
    extendedTextMessage: { text: ar },
    templateMessage: { hydratedTemplate: {} },
  },
  ar,
);

expectText("plain arabic conversation", { conversation: ar }, ar);
expectText("english", { conversation: "Hello clinic" }, "Hello clinic");
expectText("mixed + emoji", { conversation: mixed }, mixed);
expectText("long arabic", { conversation: longAr }, longAr);

expectText(
  "ephemeral arabic",
  { ephemeralMessage: { message: { conversation: ar } } },
  ar,
);

expectText(
  "viewOnce arabic",
  { viewOnceMessage: { message: { conversation: ar } } },
  ar,
);

expectText(
  "edited arabic",
  { editedMessage: { message: { extendedTextMessage: { text: "رسالة معدّلة" } } } },
  "رسالة معدّلة",
);

expectText(
  "quoted reply arabic",
  {
    extendedTextMessage: {
      text: ar,
      contextInfo: {
        stanzaId: "ABC123",
        quotedMessage: { conversation: "الأصل" },
      },
    },
  },
  ar,
);

expectText(
  "newsletter wrapper",
  { newsletterMessage: { message: { conversation: ar } } },
  ar,
);

expectText(
  "groupMentionedMessage",
  {
    groupMentionedMessage: {
      message: { extendedTextMessage: { text: "مرحبا @all" } },
    },
  },
  "مرحبا @all",
);

expectText(
  "statusMentionMessage",
  { statusMentionMessage: { message: { conversation: "من الحالة" } } },
  "من الحالة",
);

expectText(
  "deviceSentMessage",
  { deviceSentMessage: { message: { conversation: ar } } },
  ar,
);

// Buffer UTF-8
{
  const n = normalizeIncomingMessage({ conversation: Buffer.from(ar, "utf8") });
  assert.equal(n.text, ar);
  console.log("✓ buffer utf-8 arabic");
}

// Interactive replies
{
  const n = normalizeIncomingMessage({
    buttonsResponseMessage: { selectedDisplayText: "تأكيد" },
  });
  assert.equal(n.text, "تأكيد");
  console.log("✓ buttons response arabic");
}

// System stub
{
  const n = normalizeIncomingMessage({ messageContextInfo: {} });
  assert.equal(n.message_type, "system");
  assert.equal(n.text, null);
  console.log("✓ system stub");
}

// Never promote placeholders
{
  const n = normalizeIncomingMessage({ conversation: "[message]" });
  assert.equal(n.text, null);
  console.log("✓ rejects [message] placeholder");
}

// serialize keeps arabic
{
  const raw = serializeMessageForWebhook({
    conversation: ar,
    buttonsMessage: { contentText: "" },
  });
  assert.equal(raw.conversation, ar);
  console.log("✓ serializeMessageForWebhook keeps arabic");
}

console.log("\nAll normalizeIncomingMessage regression tests passed.");
