#!/usr/bin/env node
/**
 * Phase 1 inbound smoke tests (no network, no Laravel).
 * Run: node scripts/test-inbound-payload.mjs
 */
import {
  buildInboundPayload,
  buildStatusPayload,
} from "../src/inbound.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed += 1;
  } else {
    console.log("OK:", msg);
  }
}

const baseKey = {
  remoteJid: "201234567890@s.whatsapp.net",
  id: "MSG1",
  fromMe: false,
};

const text = buildInboundPayload(5, {
  key: baseKey,
  messageTimestamp: 1720000000,
  pushName: "Tester",
  message: { conversation: "Hello" },
}, "notify");
assert(text?.text === "Hello", "text body extracted");
assert(text?.clinic_id === 5, "clinic_id preserved");
assert(text?.from_me === false, "from_me false");

const globalMsg = buildInboundPayload(0, {
  key: { ...baseKey, id: "G0" },
  message: { conversation: "Global hi" },
}, "notify");
assert(globalMsg?.clinic_id === 0, "global clinic_id=0");

assert(
  buildInboundPayload(5, {
    key: { remoteJid: "120363@g.us", id: "G", fromMe: false },
    message: { conversation: "group" },
  }, "notify") === null,
  "groups ignored",
);

assert(
  buildInboundPayload(5, {
    key: { ...baseKey, id: "SYS", fromMe: false },
    message: { protocolMessage: { type: 0 } },
  }, "notify") === null,
  "protocol/system ignored",
);

const clinicA = buildInboundPayload(1, {
  key: { ...baseKey, id: "C1" },
  message: { conversation: "a" },
}, "notify");
const clinicB = buildInboundPayload(2, {
  key: { ...baseKey, id: "C1" },
  message: { conversation: "b" },
}, "notify");
assert(clinicA.clinic_id === 1 && clinicB.clinic_id === 2, "different clinics keep separate clinic_id");

const status = buildStatusPayload(5, {
  key: { id: "MSG1", remoteJid: baseKey.remoteJid, fromMe: true },
  update: { status: 4 },
});
assert(status?.status === "read" && status?.event === "message_status", "read receipt mapped");

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll inbound payload tests passed.");
