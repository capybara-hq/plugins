import { Badge, Button, ItemListItem, Stack, Text } from "@capybara-hq/plugin-client";
import { useState } from "react";
import type { DecisionRow, DecisionState } from "../page/contract.js";
import { COPY, type Copy } from "./i18n.js";
import { errorText, useCollabAction, useT } from "./shared.js";

const STATE_LABEL: Record<DecisionState, Copy> = {
  open: COPY.open,
  answered: COPY.answered,
  canceled: COPY.canceled,
  expired: COPY.expired,
};

const APPROVE: Copy = { zh: "批准", en: "Approve" };
const REJECT: Copy = { zh: "驳回", en: "Reject" };
const GATE_LABELS: Readonly<Record<string, Copy>> = { approve: APPROVE, reject: REJECT };

/**
 * The buttons that answer a decision the viewer may answer: approve / reject for a gate request,
 * one button per option for a question (the recommended one stands out). Refusals come back as
 * the host's toast; a thrown error shows under the buttons.
 */
export function DecisionAnswers({ decision }: { decision: DecisionRow }) {
  const t = useT();
  const act = useCollabAction();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!decision.canAnswer || decision.state !== "open") return null;

  const run = async (id: string, call: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap={4}>
      <Stack direction="row" gap={8} wrap>
        {decision.kind === "gate" ? (
          <>
            <Button
              variant="primary"
              loading={busy === "approve"}
              disabled={busy !== null}
              onClick={() =>
                void run("approve", () =>
                  act("gate.confirm", { decisionId: decision.id, approve: true }),
                )
              }
            >
              {t(APPROVE)}
            </Button>
            <Button
              loading={busy === "reject"}
              disabled={busy !== null}
              onClick={() =>
                void run("reject", () =>
                  act("gate.confirm", { decisionId: decision.id, approve: false }),
                )
              }
            >
              {t(REJECT)}
            </Button>
          </>
        ) : (
          decision.options.map((o) => (
            <Button
              key={o.id}
              variant={decision.recommendation?.optionId === o.id ? "primary" : "default"}
              loading={busy === o.id}
              disabled={busy !== null}
              onClick={() =>
                void run(o.id, () =>
                  act("decision.answer", { decisionId: decision.id, optionId: o.id }),
                )
              }
            >
              {o.label}
            </Button>
          ))
        )}
      </Stack>
      {error !== null && (
        <Text variant="small" tone="fail">
          {error}
        </Text>
      )}
    </Stack>
  );
}

/** One decision as a list item: the question, its state, the recommendation and the answers. */
export function DecisionItem({ decision }: { decision: DecisionRow }) {
  const t = useT();
  // A gate's two answers are named in the viewer's language; a question's labels are the asker's.
  const labelOf = (id: string | null | undefined): string | undefined => {
    const gate = decision.kind === "gate" ? GATE_LABELS[id ?? ""] : undefined;
    return gate ? t(gate) : decision.options.find((o) => o.id === id)?.label;
  };
  const answered =
    decision.answer === null ? null : (labelOf(decision.answer.optionId) ?? decision.answer.text);
  const meta = [
    `${t(COPY.waitingOn)} ${decision.addressee.name}`,
    decision.asker.agent === null ? decision.asker.person.name : decision.asker.agent.name,
  ].join(" · ");
  return (
    <ItemListItem
      title={decision.question}
      tag={{
        label: t(decision.kind === "gate" ? COPY.gate : COPY.question),
        tone: decision.state === "open" ? "accent" : "default",
      }}
      meta={meta}
      marks={
        <Stack direction="row" gap={4}>
          <Badge tone={decision.state === "open" ? "accent" : "default"}>
            {t(STATE_LABEL[decision.state])}
          </Badge>
          {decision.blocking && decision.state === "open" && (
            <Badge tone="warn">{t(COPY.blocking)}</Badge>
          )}
        </Stack>
      }
    >
      <Stack gap={8}>
        {decision.recommendation !== null && decision.state === "open" && (
          <Text variant="small" tone="muted">
            {[labelOf(decision.recommendation.optionId), decision.recommendation.why]
              .filter((x) => x !== undefined && x !== "")
              .reduce((line, x) => `${line} — ${x}`, t(COPY.recommended))}
          </Text>
        )}
        {answered !== null && answered !== undefined && (
          <Text variant="small">{`${t(COPY.answered)}: ${answered}`}</Text>
        )}
        <DecisionAnswers decision={decision} />
      </Stack>
    </ItemListItem>
  );
}
