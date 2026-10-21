import { describe, expect, it } from "vitest";
import {
  ACTION_VALUE_MAX,
  type ActionValue,
  decodeActionValue,
  encodeActionValue,
  parseBlockActions,
} from "../src/actions.js";

const ID = "6f1c0d7e-1111-4222-8333-944455556666";

describe("action value encode / decode", () => {
  it("round-trips approval, single-select and multi-select values", () => {
    const vs: ActionValue[] = [
      { k: "a", id: ID, action: "approve", scope: "session" },
      { k: "a", id: ID, action: "deny" },
      { k: "q", id: ID, key: "env", value: "prod" },
      { k: "m", id: ID, key: "envs", options: ["dev", "prod"] },
    ];
    for (const v of vs) expect(decodeActionValue(encodeActionValue(v))).toEqual(v);
  });

  it("is compact", () => {
    const s = encodeActionValue({ k: "a", id: ID, action: "approve", scope: "once" });
    expect(s.length).toBeLessThan(70);
  });

  it("throws when the encoded value exceeds Slack's 2000-character limit", () => {
    expect(ACTION_VALUE_MAX).toBe(2000);
    expect(() => encodeActionValue({ k: "q", id: ID, key: "k", value: "x".repeat(2000) })).toThrow(
      /2000/,
    );
  });

  it("rejects malformed values", () => {
    for (const bad of [
      "",
      "not json",
      "{}",
      "[]",
      '["a"]',
      `["a","${ID}","approve","forever"]`,
      `["a","${ID}","maybe"]`,
      `["a","","approve"]`,
      `["a","${ID}","deny","once"]`,
      `["q","${ID}","k"]`,
      `["q","${ID}","k",5]`,
      `["m","${ID}","k","dev"]`,
      `["m","${ID}","k",[1]]`,
      `["z","${ID}"]`,
      `["a","${ID}","approve","once","extra"]`,
      "x".repeat(2001),
    ]) {
      expect(decodeActionValue(bad), bad).toBeNull();
    }
  });
});

const basePayload = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "block_actions",
  user: { id: "U1", team_id: "T1", username: "alice", name: "alice" },
  team: { id: "T1" },
  container: {
    type: "message",
    message_ts: "1700.000200",
    channel_id: "C1",
    thread_ts: "1700.000100",
  },
  channel: { id: "C1" },
  message: { ts: "1700.000200", thread_ts: "1700.000100" },
  state: { values: {} },
  actions: [{ type: "button", block_id: "b", action_ts: "1700.900000", ...action }],
  ...extra,
});

describe("parseBlockActions", () => {
  it("approval button → card_action with stable eventId, card message id and thread", () => {
    const value = encodeActionValue({ k: "a", id: ID, action: "approve", scope: "once" });
    const r = parseBlockActions(basePayload({ action_id: "cap_a_once", value }));
    expect(r).toEqual({
      messageId: "C1:1700.000200",
      eventId: "C1:1700.000200:U1:1700.900000",
      target: { chatId: "C1", chatType: "group", threadId: "C1:1700.000100" },
      sender: { externalId: "U1", tenantId: "T1" },
      username: "alice",
      action: { cardKind: "approval", cardId: ID, action: "approve", scope: "once" },
    });
  });

  it("DM card → chatType dm without threadId", () => {
    const value = encodeActionValue({ k: "a", id: ID, action: "deny" });
    const r = parseBlockActions(
      basePayload(
        { action_id: "cap_a_deny", value },
        {
          container: { type: "message", message_ts: "1.2", channel_id: "D1" },
          channel: { id: "D1" },
          message: { ts: "1.2" },
        },
      ),
    );
    expect(r?.target).toEqual({ chatId: "D1", chatType: "dm" });
    expect(r?.action).toEqual({ cardKind: "approval", cardId: ID, action: "deny" });
  });

  it("single-select question button → answer", () => {
    const value = encodeActionValue({ k: "q", id: ID, key: "env", value: "prod" });
    const r = parseBlockActions(basePayload({ action_id: "cap_q_1", value }));
    expect(r?.action).toEqual({
      cardKind: "question",
      cardId: ID,
      action: "answer",
      answer: { env: "prod" },
    });
  });

  it("multi-select submit reads the checked options from state.values", () => {
    const value = encodeActionValue({
      k: "m",
      id: ID,
      key: "envs",
      options: ["dev", "qa", "prod"],
    });
    const r = parseBlockActions(
      basePayload(
        { action_id: "cap_m_submit", value },
        {
          state: {
            values: {
              [`cap_m_${ID}`]: {
                cap_m_select: {
                  type: "checkboxes",
                  selected_options: [{ value: "0" }, { value: "2" }],
                },
              },
            },
          },
        },
      ),
    );
    expect(r?.action).toEqual({
      cardKind: "question",
      cardId: ID,
      action: "answer",
      answer: { envs: ["dev", "prod"] },
    });
  });

  it("multi-select submit with nothing checked answers an empty list", () => {
    const value = encodeActionValue({ k: "m", id: ID, key: "envs", options: ["dev"] });
    const r = parseBlockActions(basePayload({ action_id: "cap_m_submit", value }));
    expect(r?.action.answer).toEqual({ envs: [] });
  });

  it("ignores link buttons, checkbox toggles, foreign actions and malformed payloads", () => {
    expect(parseBlockActions(basePayload({ action_id: "cap_link_web" }))).toBeNull();
    expect(
      parseBlockActions(basePayload({ action_id: "cap_m_select", type: "checkboxes" })),
    ).toBeNull();
    expect(parseBlockActions(basePayload({ action_id: "other_app", value: "x" }))).toBeNull();
    expect(
      parseBlockActions(basePayload({ action_id: "cap_a_once", value: "garbage" })),
    ).toBeNull();
    // 勾选项越界
    const value = encodeActionValue({ k: "m", id: ID, key: "envs", options: ["dev"] });
    expect(
      parseBlockActions(
        basePayload(
          { action_id: "cap_m_submit", value },
          {
            state: {
              values: { [`cap_m_${ID}`]: { cap_m_select: { selected_options: [{ value: "7" }] } } },
            },
          },
        ),
      ),
    ).toBeNull();
    expect(parseBlockActions({ type: "block_actions" })).toBeNull();
    expect(parseBlockActions({ type: "view_submission" })).toBeNull();
    expect(parseBlockActions(null)).toBeNull();
  });
});
