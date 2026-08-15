// Preload shim for the smoke driver — loaded into the AGENT process only via `node --import`.
// The agent is a Slack bot: Bolt's App.init() calls `auth.test` at startup (App.js:219, when
// tokenVerificationEnabled defaults true), which hard-fails with a dummy token and crashes the
// boot. This stubs @slack/web-api so every Slack call no-ops offline: `auth.test` returns a fake
// identity (so start() proceeds) and all other calls return {ok:true} (so the background
// investigation's postMessage doesn't throw). Product code is never touched — the hack lives
// only here and is applied only to the agent, not the stdio mcp-server child.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url); // resolves to <repo>/node_modules/@slack/web-api
const { WebClient } = require("@slack/web-api");

WebClient.prototype.apiCall = async function apiCall(method, options = {}) {
  if (method === "auth.test") {
    return { ok: true, user_id: "U_SMOKE", bot_id: "B_SMOKE", team_id: "T_SMOKE", url: "https://smoke.invalid/" };
  }
  // Every other call (chat.postMessage, chat.update, conversations.replies, …) no-ops with a
  // plausible shape so offline code paths don't throw.
  return { ok: true, ts: "1700000000.000000", channel: options.channel ?? "C_SMOKE", message: {}, messages: [] };
};

console.error("[smoke] @slack/web-api stubbed — Slack calls no-op offline");
