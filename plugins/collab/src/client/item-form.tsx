import {
  Button,
  Dialog,
  Field,
  Input,
  Markdown,
  PrincipalPicker,
  Segmented,
  Select,
  Stack,
  Tabs,
  Text,
  Textarea,
} from "@capybara-hq/plugin-client";
import { useState } from "react";
import type { AgentRef, ItemDetail, ItemTypeInfo, PersonRef, Priority } from "../page/contract.js";
import { COPY, PRIORITY_LABEL } from "./i18n.js";
import {
  agentOption,
  errorText,
  isNotFound,
  parseLabels,
  personOption,
  useCollabAction,
  useCollabQuery,
  useT,
} from "./shared.js";

export interface ItemFormProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  project: { id: string; key: string };
  /** Create: the types to choose from and the preselected one. */
  types: ItemTypeInfo[];
  defaultType?: string;
  /** Edit: the item as `item.detail` gave it. */
  item?: ItemDetail;
  /** Create: the parent of a new child item. */
  parentId?: string;
  /** Called after a successful save. */
  onSaved?(): void;
}

/** Order of the priority control: none, then urgent to low. */
const PRIORITIES: Priority[] = [0, 1, 2, 3, 4];

/**
 * The item dialog: title, Markdown description with a preview, the responsible person, the
 * executing agent (only agents the chosen person may use), priority and labels. Creating calls
 * `item.create`; editing calls `item.update` for the fields and `item.assign` when the
 * assignment changed.
 */
export function ItemForm(props: ItemFormProps) {
  // a fresh form per opening: the fields start from the item (or empty) each time
  return props.open ? <ItemFormDialog {...props} /> : null;
}

function ItemFormDialog(props: ItemFormProps) {
  const t = useT();
  const act = useCollabAction();
  const { item } = props;
  const [type, setType] = useState(props.defaultType ?? props.types[0]?.key ?? "");
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [responsible, setResponsible] = useState<PersonRef | null>(item?.responsible ?? null);
  const [agent, setAgent] = useState<AgentRef | null>(item?.agent ?? null);
  const [priority, setPriority] = useState<Priority>(item?.priority ?? 3);
  const [labels, setLabels] = useState((item?.labels ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const titleOk = title.trim() !== "";

  const save = async () => {
    setTouched(true);
    if (!titleOk) return;
    setBusy(true);
    setError(null);
    try {
      const done = item === undefined ? await create() : await update(item);
      if (done) {
        props.onOpenChange(false);
        props.onSaved?.();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const create = async (): Promise<boolean> => {
    const r = await act("item.create", {
      projectId: props.project.id,
      type,
      title: title.trim(),
      ...(description.trim() !== "" && { description }),
      ...(props.parentId !== undefined && { parentId: props.parentId }),
      ...(responsible !== null && { responsibleAccountId: responsible.id }),
      ...(responsible !== null && agent !== null && { agentId: agent.id }),
      priority,
      labels: parseLabels(labels),
    });
    return r.toast === undefined;
  };

  const update = async (current: ItemDetail): Promise<boolean> => {
    const nextLabels = parseLabels(labels);
    const fieldsChanged =
      title.trim() !== current.title ||
      description !== current.description ||
      priority !== current.priority ||
      nextLabels.join("\n") !== current.labels.join("\n");
    let version = current.version;
    if (fieldsChanged) {
      const r = await act("item.update", {
        itemId: current.id,
        version,
        title: title.trim(),
        description,
        priority,
        labels: nextLabels,
      });
      if (r.toast !== undefined) return false;
      version += 1;
    }
    const assignChanged =
      responsible !== null &&
      (responsible.id !== current.responsible?.id ||
        (agent?.id ?? null) !== (current.agent?.id ?? null));
    if (assignChanged) {
      const r = await act("item.assign", {
        itemId: current.id,
        version,
        responsibleAccountId: responsible.id,
        agentId: agent?.id ?? null,
      });
      if (r.toast !== undefined) return false;
    }
    return true;
  };

  return (
    <Dialog
      open
      onOpenChange={props.onOpenChange}
      title={t(item === undefined ? COPY.newItem : COPY.editItem)}
      size={640}
      footer={
        <>
          <Button onClick={() => props.onOpenChange(false)}>{t(COPY.cancel)}</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t(item === undefined ? COPY.create : COPY.save)}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        {item === undefined && props.types.length > 1 && (
          <Field label={t(COPY.type)}>
            <Select
              aria-label={t(COPY.type)}
              value={type}
              options={props.types.map((ty) => ({ value: ty.key, label: t(ty.name) }))}
              onChange={(e) => setType(e.target.value)}
            />
          </Field>
        )}
        <Field
          label={t(COPY.title)}
          required
          {...(touched && !titleOk && { error: t(COPY.titleRequired) })}
        >
          <Input
            aria-label={t(COPY.title)}
            value={title}
            autoFocus
            invalid={touched && !titleOk}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Stack gap={8}>
          <Tabs
            label={t(COPY.descriptionTabs)}
            look="segmented-compact"
            value={mode}
            onChange={(id) => setMode(id === "preview" ? "preview" : "write")}
            items={[
              { id: "write", label: t(COPY.write) },
              { id: "preview", label: t(COPY.preview) },
            ]}
          />
          {mode === "write" ? (
            <Textarea
              aria-label={t(COPY.description)}
              value={description}
              rows={8}
              onChange={(e) => setDescription(e.target.value)}
            />
          ) : description.trim() === "" ? (
            <Text tone="muted">{t(COPY.nothingToPreview)}</Text>
          ) : (
            <Markdown text={description} />
          )}
        </Stack>
        <ResponsiblePicker
          projectKey={props.project.key}
          value={responsible}
          onChange={(p) => {
            setResponsible(p);
            // an agent belongs to its person: a new person starts without one
            if (p?.id !== responsible?.id) setAgent(null);
          }}
        />
        {responsible === null ? (
          <Field label={t(COPY.agent)} help={t(COPY.pickResponsibleFirst)}>
            <PrincipalPicker
              aria-label={t(COPY.agent)}
              options={[]}
              value={[]}
              onChange={() => {}}
              disabled
            />
          </Field>
        ) : (
          <AgentPicker
            projectKey={props.project.key}
            accountId={responsible.id}
            value={agent}
            onChange={setAgent}
          />
        )}
        <Field label={t(COPY.priority)}>
          <Segmented
            label={t(COPY.priority)}
            value={String(priority)}
            options={PRIORITIES.map((p) => ({
              value: String(p),
              label: t(PRIORITY_LABEL[p] ?? COPY.none),
            }))}
            onChange={(v) => setPriority(Number(v) as Priority)}
          />
        </Field>
        <Field label={t(COPY.labels)} optional help={t(COPY.labelsHelp)}>
          <Input
            aria-label={t(COPY.labels)}
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
        </Field>
        {error !== null && (
          <Text variant="small" tone="fail">
            {error}
          </Text>
        )}
      </Stack>
    </Dialog>
  );
}

/** The project's owners and members, searched as the person types. */
function ResponsiblePicker(props: {
  projectKey: string;
  value: PersonRef | null;
  onChange(p: PersonRef | null): void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const q = useCollabQuery(
    "people.search",
    { query, project: props.projectKey },
    { staleMs: 30_000 },
  );
  const people = q.data !== undefined && !isNotFound(q.data) ? q.data.people : [];
  // keep the chosen person among the options while a search leaves them out
  const options =
    props.value !== null && !people.some((p) => p.id === props.value?.id)
      ? [props.value, ...people]
      : people;
  return (
    <Field label={t(COPY.responsible)}>
      <PrincipalPicker
        aria-label={t(COPY.responsible)}
        placeholder={t(COPY.pickResponsible)}
        options={options.map(personOption)}
        value={props.value === null ? [] : [props.value.id]}
        loading={q.status === "loading"}
        onSearch={setQuery}
        onChange={(ids) => props.onChange(options.find((p) => p.id === ids[0]) ?? null)}
      />
    </Field>
  );
}

/** The agents the chosen responsible person may use (`agents.usable`), plus "no agent". */
function AgentPicker(props: {
  projectKey: string;
  accountId: string;
  value: AgentRef | null;
  onChange(a: AgentRef | null): void;
}) {
  const t = useT();
  const q = useCollabQuery(
    "agents.usable",
    { project: props.projectKey, accountId: props.accountId },
    { staleMs: 30_000 },
  );
  const agents = q.data !== undefined && !isNotFound(q.data) ? q.data.agents : [];
  return (
    <Field
      label={t(COPY.agent)}
      optional
      action={
        props.value === null ? null : (
          <Button variant="ghost" onClick={() => props.onChange(null)}>
            {t(COPY.noAgent)}
          </Button>
        )
      }
    >
      <PrincipalPicker
        aria-label={t(COPY.agent)}
        placeholder={t(COPY.pickAgent)}
        options={agents.map(agentOption)}
        value={props.value === null ? [] : [props.value.id]}
        loading={q.status === "loading"}
        onChange={(ids) => props.onChange(agents.find((a) => a.id === ids[0]) ?? null)}
      />
    </Field>
  );
}
