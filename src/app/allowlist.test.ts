import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";
import { config } from "../config/index.js";

// SLACK_ALLOWED_USERS: being in the channel is not enough to drive the agent. A refused user
// gets an ephemeral note and nothing else — no "On it", no LLM call, no learn.

const original = { ...config.slack };
afterEach(() => Object.assign(config.slack, original));

const harness = () => {
  const said: any[] = [];
  const ephemeral: any[] = [];
  const replies: any[] = [];
  const self: any = {
    agent: new Proxy({}, { get: () => () => assert.fail("the agent must not be reached") }),
  };
  const client: any = {
    chat: { postEphemeral: async (m: any) => void ephemeral.push(m) },
    conversations: { replies: async (m: any) => (replies.push(m), { messages: [] }) },
  };
  const proto = SlackApp.prototype as any;
  self.mayUseAgent = proto.mayUseAgent;
  const mention = (user: string | undefined, text: string) =>
    proto.handleMention.call(self, {
      event: { user, text, channel: "C1", ts: "1.1" },
      say: async (m: any) => void said.push(m),
      client,
    });
  const react = (user: string) => proto.handleLearnByReaction.call(self, "C1", "1.1", user, client);
  return { said, ephemeral, replies, mention, react };
};

test("a mention from a user outside the allowlist gets an ephemeral refusal and nothing else", async () => {
  Object.assign(config.slack, { allowedUsers: ["U1"], oncallUsers: [], approverUsers: [] });
  const h = harness();
  await h.mention("U9", "<@BOT> cek pods di sample-apps");
  assert.equal(h.said.length, 0, "no public reply");
  assert.equal(h.ephemeral.length, 1);
  assert.equal(h.ephemeral[0].user, "U9");
  assert.equal(h.ephemeral[0].thread_ts, "1.1");
});

test("an allowed user, and on-call, get past the gate", async () => {
  Object.assign(config.slack, { allowedUsers: ["U1"], oncallUsers: ["U2"], approverUsers: [] });
  const h = harness();
  // empty text = the greeting path, which proves the gate let it through without the agent
  await h.mention("U1", "<@BOT>");
  await h.mention("U2", "<@BOT>");
  assert.equal(h.said.length, 2);
  assert.equal(h.ephemeral.length, 0);
});

test("an empty allowlist leaves mentions open to everyone", async () => {
  Object.assign(config.slack, { allowedUsers: [], oncallUsers: ["U2"], approverUsers: [] });
  const h = harness();
  await h.mention("U9", "<@BOT>");
  assert.equal(h.said.length, 1);
});

test("a ✅ from a user outside the allowlist learns nothing and says nothing", async () => {
  Object.assign(config.slack, { allowedUsers: ["U1"], oncallUsers: [], approverUsers: [] });
  const h = harness();
  await h.react("U9");
  assert.equal(h.replies.length, 0, "the thread is never even read");
  assert.equal(h.ephemeral.length, 0, "silent, like a ✅ outside an incident thread");
});
