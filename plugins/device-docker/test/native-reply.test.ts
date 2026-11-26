import { NATIVE_FAILURE_GENERIC, nativeFailureText } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { nativeReply } from "../src/operations.js";

const failed = (code: string) =>
  nativeReply({ native: { error: { code, message: "helper detail" } } } as never, true);

describe("a failed native operation names its cause (capybara-hq/core#907)", () => {
  it("throws the SDK's text for the helper's code, never the helper's message", () => {
    expect(() => failed("ENOENT")).toThrow(nativeFailureText("ENOENT"));
    expect(() => failed("NOT_REGULAR_FILE")).toThrow(nativeFailureText("NOT_REGULAR_FILE"));
    expect(() => failed("INVALID_NATIVE_REQUEST")).toThrow(NATIVE_FAILURE_GENERIC);
    expect(() => failed("ENOENT")).not.toThrow(/helper detail/);
  });
});
