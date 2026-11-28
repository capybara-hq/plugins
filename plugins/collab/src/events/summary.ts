/** The kernel's limit on an event summary, in UTF-8 bytes. */
export const SUMMARY_MAX_BYTES = 4096;
/** How much of a description a summary quotes. */
const DESCRIPTION_CHARS = 500;

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

/** What a summary can say about the change, beyond the item itself. */
export interface SummaryDetail {
  fromStatus?: string;
  toStatus?: string;
  changedFields?: string[];
  comment?: string;
  responsibleAccountId?: string | null;
  executingAgentId?: string | null;
  description?: string;
}

/**
 * The English one-paragraph account of an event the model reads in the run it starts. Never the
 * full description (the first 500 characters at most); always within the kernel's byte limit.
 */
export function summarize(type: string, key: string, title: string, detail: SummaryDetail): string {
  const parts: string[] = [];
  const subject = `${key} "${title}"`;
  switch (type) {
    case "item.created":
      parts.push(`${subject} was created.`);
      break;
    case "item.status_changed":
      parts.push(`${subject}: status changed from "${detail.fromStatus}" to "${detail.toStatus}".`);
      break;
    case "item.closed":
      parts.push(`${subject} was closed as "${detail.toStatus}".`);
      break;
    case "item.assigned":
      parts.push(
        `${subject} was assigned to account ${detail.responsibleAccountId}` +
          (detail.executingAgentId ? ` with agent ${detail.executingAgentId}.` : "."),
      );
      break;
    case "item.unassigned":
      parts.push(
        `${subject} is no longer assigned to agent ${detail.executingAgentId}` +
          (detail.responsibleAccountId ? ` of account ${detail.responsibleAccountId}.` : "."),
      );
      break;
    case "item.commented":
      parts.push(`New comment on ${subject}.`);
      break;
    case "gate.requested":
      parts.push(`A move of ${subject} to "${detail.toStatus}" waits for confirmation.`);
      break;
    default:
      parts.push(`${subject} was updated.`);
  }
  if (detail.changedFields?.length) parts.push(`Changed: ${detail.changedFields.join(", ")}.`);
  if (detail.comment) parts.push(`Comment: ${detail.comment.slice(0, DESCRIPTION_CHARS)}`);
  if (detail.description) {
    parts.push(`Description: ${detail.description.slice(0, DESCRIPTION_CHARS)}`);
  }
  return clipBytes(parts.join(" "), SUMMARY_MAX_BYTES);
}
