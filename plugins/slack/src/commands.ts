/**
 * Slack slash commands. Slack treats a message that starts with `/` as a slash command and rejects
 * names no app registered ("/env is not a valid command"), so the kernel's text commands (`/new`,
 * `/env [name]`, `/<skill> args`) never arrive as message events. The app manifest registers `/new`,
 * `/env` and one generic `/capybara <skill> [args]`; this module turns their payloads back into the
 * text the kernel parses. The extension still parses no command itself: it only rebuilds the text
 * the person would have typed.
 *
 * Payload fields (https://docs.slack.dev/interactivity/implementing-slash-commands , checked
 * 2026-11-08): `command`, `text`, `user_id`, `user_name`, `channel_id`, `team_id`, `trigger_id`. Socket
 * Mode delivers them as the `slash_commands` envelope payload; a webhook gets them as a form body.
 * Slack needs the ack within 3 seconds and does not retry a slash command; the ack body may carry
 * an ephemeral reply.
 */

/** A slash command invocation, as far as the plugin reads it. */
export interface SlashCommand {
  command: string;
  text: string;
  userId: string;
  userName: string | undefined;
  channelId: string;
  teamId: string;
  triggerId: string;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** The generic entry of the manifest; every command other than `/new` and `/env` maps like it. */
export const GENERIC_COMMAND = "/capybara";

/** Reads a slash command payload (Socket Mode payload or decoded webhook form); null when malformed. */
export function parseSlashCommand(body: unknown): SlashCommand | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const command = str(b.command);
  const userId = str(b.user_id);
  const channelId = str(b.channel_id);
  const teamId = str(b.team_id);
  const triggerId = str(b.trigger_id);
  if (!command?.startsWith("/") || !userId || !channelId || !teamId || !triggerId) return null;
  return {
    command,
    text: typeof b.text === "string" ? b.text : "",
    userId,
    userName: str(b.user_name),
    channelId,
    teamId,
    triggerId,
  };
}

const unescapeSlack = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * The message text the kernel gets for a command: `/new` → `/new`, `/env x` → `/env x`, and any
 * other command (the generic `/capybara`, or whatever name an admin gave it) `/capybara foo bar`
 * → `/foo bar` (a leading `/` the person typed after it is not doubled). Null when the generic
 * command has no skill name (the caller answers with the usage).
 */
export function slashCommandText(command: string, text: string): string | null {
  const args = unescapeSlack(text).trim();
  const name = command.toLowerCase();
  if (name === "/new" || name === "/env") return args === "" ? name : `${name} ${args}`;
  const rest = args.replace(/^\/+/, "");
  return rest === "" ? null : `/${rest}`;
}

/** Escapes text for a Slack message so a typed `<!channel>` stays text. */
export const escapeSlack = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the person typed, for the echo (`/capybara foo bar`). */
export const typedCommand = (c: SlashCommand) =>
  c.text.trim() === "" ? c.command : `${c.command} ${unescapeSlack(c.text).trim()}`;

/** The ack body of an ephemeral reply (shown only to the person who ran the command). */
export const ephemeral = (text: string): Record<string, unknown> => ({
  response_type: "ephemeral",
  text,
});

/**
 * Fixed replies. The org's IM language is not known on inbound, so they are bilingual like
 * Slack's own one-line notices.
 */
export const SLASH_REPLIES = {
  usage: `Usage: ${GENERIC_COMMAND} <skill> [args] · 用法：${GENERIC_COMMAND} <技能> [参数]`,
  wrongDm:
    "Run Capybara commands in your direct message with the app, or in a channel it is in. · " +
    "请在与 Capybara 应用的私聊里，或在它所在的频道里使用命令。",
  notInChannel:
    "Invite the Capybara app to this channel first (/invite), then run the command again. · " +
    "请先把 Capybara 应用邀请进这个频道，再运行命令。",
  failed:
    "Slack could not take this command right now; try again in a moment. · " +
    "Slack 暂时无法处理这条命令，请稍后再试。",
} as const;
