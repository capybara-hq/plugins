import { describe, expect, it } from "vitest";
import {
  ACTION_VALUE_MAX,
  type ActionValue,
  decodeActionValue,
  encodeActionValue,
  MULTI_FIELD,
  parseCardAction,
  VALUE_KEY,
} from "../src/actions.js";

describe("action value encode / decode", () => {
  it("round-trips every kind compactly", () => {
    const vals = [
      { k: "a", chat: "g", id: "apr_1", action: "approve", scope: "once" },
      { k: "a", chat: "d", id: "apr_1", action: "approve", scope: "always" },
      { k: "a", chat: "g", id: "apr_1", action: "deny" },
      { k: "q", chat: "d", id: "q_1", key: "env", value: "prod" },
      { k: "m", chat: "g", id: "q_2", key: "envs", options: ["a", "b"] },
    ] satisfies ActionValue[];
    for (const v of vals) {
      const s = encodeActionValue(v);
      expect(s.startsWith("[")).toBe(true);
      expect(decodeActionValue(s)).toEqual(v);
    }
    expect(encodeActionValue(vals[0] as ActionValue)).toBe('["a","g","apr_1","approve","once"]');
  });

  it("refuses values over the size cap", () => {
    expect(() =>
      encodeActionValue({
        k: "q",
        chat: "d",
        id: "q",
        key: "k",
        value: "x".repeat(ACTION_VALUE_MAX),
      }),
    ).toThrow(/limit/);
  });

  it("rejects malformed values strictly", () => {
    const bad = [
      "",
      "not json",
      "{}",
      "[]",
      '["a","g","id","approve"]',
      '["a","g","id","approve","forever"]',
      '["a","x","id","deny"]',
      '["a","g","","deny"]',
      '["a","g","id","deny","extra"]',
      '["q","d","id","k"]',
      '["q","d","id","",""]',
      '["q","d","id","k",1]',
      '["m","d","id","k",[1]]',
      '["m","d","id","k","a"]',
      '["z","d","id"]',
      `["q","d","id","k","${"x".repeat(ACTION_VALUE_MAX)}"]`,
    ];
    for (const s of bad) expect(decodeActionValue(s), s).toBeNull();
  });
});

const callback = (
  over: { action?: Record<string, unknown>; event?: Record<string, unknown> } = {},
) => ({
  schema: "2.0",
  header: {
    event_id: "evt_1",
    token: "verification-token",
    create_time: "1760000000000000",
    event_type: "card.action.trigger",
    tenant_key: "tenant_app",
    app_id: "cli_a1b2c3d4e5f60718",
  },
  event: {
    operator: { tenant_key: "tenant_op", open_id: "ou_alice", union_id: "on_alice" },
    token: "c-update-token",
    action: {
      tag: "button",
      value: { [VALUE_KEY]: '["a","g","apr_1","approve","session"]' },
      ...over.action,
    },
    host: "im_message",
    context: { open_message_id: "om_card", open_chat_id: "oc_group" },
    ...over.event,
  },
});

describe("parseCardAction", () => {
  it("button → approval action; ids from the callback", () => {
    expect(parseCardAction(callback())).toEqual({
      messageId: "om_card",
      eventId: "evt_1",
      target: { chatId: "oc_group", chatType: "group" },
      sender: { externalId: "ou_alice", tenantId: "tenant_op" },
      action: { cardKind: "approval", cardId: "apr_1", action: "approve", scope: "session" },
    });
  });

  it("chat type comes from the value; operator tenant falls back to the header", () => {
    const p = parseCardAction(
      callback({
        action: { value: { [VALUE_KEY]: '["a","d","apr_1","deny"]' } },
        event: { operator: { open_id: "ou_bob" } },
      }),
    );
    expect(p?.target).toEqual({ chatId: "oc_group", chatType: "dm" });
    expect(p?.sender).toEqual({ externalId: "ou_bob", tenantId: "tenant_app" });
    expect(p?.action).toEqual({ cardKind: "approval", cardId: "apr_1", action: "deny" });
  });

  it("single-choice question button → answer", () => {
    const p = parseCardAction(
      callback({ action: { value: { [VALUE_KEY]: '["q","d","q_1","env","prod"]' } } }),
    );
    expect(p?.action).toEqual({
      cardKind: "question",
      cardId: "q_1",
      action: "answer",
      answer: { env: "prod" },
    });
  });

  it("multi-select form submit → picked options by index (deduped)", () => {
    const p = parseCardAction(
      callback({
        action: {
          tag: "button",
          name: "cap_m_submit",
          value: { [VALUE_KEY]: '["m","g","q_2","envs",["dev","staging","prod"]]' },
          form_value: { [MULTI_FIELD]: ["2", "0", "2"] },
        },
      }),
    );
    expect(p?.action).toEqual({
      cardKind: "question",
      cardId: "q_2",
      action: "answer",
      answer: { envs: ["prod", "dev"] },
    });
    const none = parseCardAction(
      callback({
        action: {
          value: { [VALUE_KEY]: '["m","g","q_2","envs",["dev"]]' },
          form_value: {},
        },
      }),
    );
    expect(none?.action.answer).toEqual({ envs: [] });
  });

  it("ignores foreign / malformed callbacks", () => {
    const bad = [
      null,
      {},
      { ...callback(), header: { ...callback().header, event_type: "im.message.receive_v1" } },
      callback({ action: { value: "string value" } }),
      callback({ action: { value: { other: "x" } } }),
      callback({ action: { value: { [VALUE_KEY]: "nope" } } }),
      callback({ event: { context: { open_chat_id: "oc_group" } } }),
      callback({ event: { operator: {} } }),
      callback({
        action: {
          value: { [VALUE_KEY]: '["m","g","q","k",["a"]]' },
          form_value: { [MULTI_FIELD]: ["5"] },
        },
      }),
      callback({
        action: {
          value: { [VALUE_KEY]: '["m","g","q","k",["a"]]' },
          form_value: { [MULTI_FIELD]: "0" },
        },
      }),
    ];
    for (const b of bad) expect(parseCardAction(b)).toBeNull();
  });

  it("a callback without event_id is still parsed (eventId omitted)", () => {
    const c = callback();
    const { event_id: _, ...header } = c.header;
    const p = parseCardAction({ ...c, header });
    expect(p).not.toBeNull();
    expect(p && "eventId" in p).toBe(false);
  });
});
