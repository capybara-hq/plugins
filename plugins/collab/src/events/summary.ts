/** The kernel's limit on an event summary, in UTF-8 bytes. */
export const SUMMARY_MAX_BYTES = 4096;
/** How much of a description, comment or answer a summary quotes. */
export const EXCERPT_CHARS = 500;
/** The most a name takes in a summary, so the first sentence always fits. */
const NAME_BYTES = 200;

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function clipBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  const ellipsis = "…";
  const budget = maxBytes - encoder.encode(ellipsis).length;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (used + size > budget) break;
    used += size;
    out += ch;
  }
  return out + ellipsis;
}

/**
 * What a summary can say about the change, beyond the item itself. Stored on the outbox row
 * (`detail`, with the item key and title); names are resolved only when the event is emitted.
 */
export interface SummaryDetail {
  fromStatus?: string;
  toStatus?: string;
  changedFields?: string[];
  comment?: string;
  /** Assignment events: the pair the item went to (assigned) or left (unassigned). */
  responsibleAccountId?: string | null;
  executingAgentId?: string | null;
  description?: string;
  /** `decision.answered`: the answer as text. */
  answer?: string;
}

/** The stored form: the summary's subject plus the detail, excerpts already cut. */
export interface StoredDetail extends SummaryDetail {
  key: string;
  title: string;
}

/** `detail` as the outbox row keeps it: free text cut to its excerpt length at write time. */
export function storedDetail(key: string, title: string, detail: SummaryDetail): StoredDetail {
  const out: StoredDetail = { ...detail, key, title };
  if (detail.comment !== undefined) out.comment = detail.comment.slice(0, EXCERPT_CHARS);
  if (detail.description !== undefined) {
    out.description = detail.description.slice(0, EXCERPT_CHARS);
  }
  if (detail.answer !== undefined) out.answer = detail.answer.slice(0, EXCERPT_CHARS);
  return out;
}

/** People's and agents' display names for one summary (ids when the kernel could not name them). */
export interface SummaryNames {
  /** Who made the change: `Li`, or `PM (agent of Li)`. */
  actor: string;
  /** The responsible person of `detail.responsibleAccountId`. */
  responsible?: string;
  /** The agent of `detail.executingAgentId`. */
  agent?: string;
}

/**
 * The English one-paragraph account of an event the model reads in the run it starts; the first
 * sentence says what happened and who did it. Never the full description (the first 500
 * characters at most); always within the kernel's byte limit.
 */
export function summarize(type: string, detail: StoredDetail, names: SummaryNames): string {
  const by = clipBytes(names.actor, NAME_BYTES);
  const responsible = clipBytes(names.responsible ?? detail.responsibleAccountId ?? "", NAME_BYTES);
  const agent = clipBytes(names.agent ?? detail.executingAgentId ?? "", NAME_BYTES);
  const subject = `${detail.key} "${detail.title}"`;
  const parts: string[] = [];
  switch (type) {
    case "item.created":
      parts.push(`${subject} was created by ${by}.`);
      break;
    case "item.status_changed":
      parts.push(
        `${subject}: status changed from "${detail.fromStatus}" to "${detail.toStatus}" by ${by}.`,
      );
      break;
    case "item.closed":
      parts.push(`${subject} was closed as "${detail.toStatus}" by ${by}.`);
      break;
    case "item.assigned":
      parts.push(
        `${subject} was assigned to ${responsible}${agent ? ` with ${agent}` : ""} by ${by}.`,
      );
      break;
    case "item.unassigned":
      parts.push(
        `${subject} is no longer assigned to ${agent}${responsible ? ` of ${responsible}` : ""} (changed by ${by}).`,
      );
      break;
    case "item.commented":
      parts.push(`${by} commented on ${subject}.`);
      break;
    case "gate.requested":
      parts.push(
        `${by} asks to move ${subject} to "${detail.toStatus}"; it waits for confirmation.`,
      );
      break;
    case "decision.answered":
      parts.push(
        `${by} answered a decision on ${subject}${detail.answer ? `: ${detail.answer}` : "."}`,
      );
      break;
    default:
      parts.push(`${subject} was updated by ${by}.`);
  }
  if (detail.changedFields?.length) parts.push(`Changed: ${detail.changedFields.join(", ")}.`);
  if (detail.comment) parts.push(`Comment: ${detail.comment.slice(0, EXCERPT_CHARS)}`);
  if (detail.description) {
    parts.push(`Description: ${detail.description.slice(0, EXCERPT_CHARS)}`);
  }
  return clipBytes(parts.join(" "), SUMMARY_MAX_BYTES);
}
