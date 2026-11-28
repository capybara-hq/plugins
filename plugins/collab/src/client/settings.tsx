import {
  Badge,
  Button,
  DangerConfirm,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FormSection,
  Input,
  ItemList,
  ItemListItem,
  PersonName,
  PrincipalPicker,
  Select,
  type SelectOption,
  SettingsPage,
  Stack,
  Switch,
  Text,
  Textarea,
  usePageParams,
} from "@capybara-hq/plugin-client";
import { useState } from "react";
import type {
  AgentRef,
  DefaultAssignmentRule,
  GateRule,
  MemberRow,
  PersonRef,
  ProjectRole,
  ProjectSettingsResult,
  StatusInfo,
  StatusSettingsPatch,
  TypeSettings,
} from "../page/contract.js";
import { COPY, type Copy, ROLE_LABEL } from "./i18n.js";
import {
  agentOption,
  ErrorLine,
  errorText,
  imageAvatar,
  isNotFound,
  pageHref,
  personOption,
  TruncatedNote,
  useActionRunner,
  useCollabAction,
  useCollabQuery,
  useT,
} from "./shared.js";

type Section = "general" | "members" | "types" | "gates" | "defaults";
const SECTIONS: { id: Section; label: Copy; ownersOnly?: boolean }[] = [
  { id: "general", label: COPY.general, ownersOnly: true },
  { id: "members", label: COPY.members },
  { id: "types", label: COPY.typesWorkflows },
  { id: "gates", label: COPY.gates },
  { id: "defaults", label: COPY.defaultAssignments },
];

const CATEGORY_LABEL: Record<string, Copy> = {
  backlog: { zh: "待规划", en: "Backlog" },
  todo: { zh: "待开始", en: "To do" },
  in_progress: { zh: "进行中", en: "In progress" },
  review: { zh: "评审中", en: "Review" },
  done: { zh: "已完成", en: "Done" },
  canceled: { zh: "已取消", en: "Canceled" },
};

/** Project settings (`project=KEY&settings=1`, `section=`): members, workflows, gates, defaults. */
export function Settings({ project }: { project: string }) {
  const t = useT();
  const params = usePageParams();
  const q = useCollabQuery("project.settings", { project });
  const data = q.data !== undefined && !isNotFound(q.data) ? q.data : undefined;
  // General is for project owners; the others open on members
  const visible = SECTIONS.filter((s) => s.ownersOnly !== true || data?.canEdit === true);
  const section: Section = visible.find((s) => s.id === params.section)?.id ?? "members";

  const nav = [
    {
      group: t(COPY.settingsNav),
      items: visible.map((s) => ({
        id: s.id,
        label: t(s.label),
        href: pageHref({ project, settings: "1", section: s.id }),
        ...(s.id === "members" && data !== undefined && { count: data.members.length }),
      })),
    },
  ];

  return (
    <SettingsPage
      header={{
        path: [{ label: data?.project.name ?? project, href: pageHref({ project }) }],
        title: t(COPY.settings),
      }}
      nav={nav}
      activeNav={section}
    >
      {q.data !== undefined && isNotFound(q.data) ? (
        <EmptyState text={t(COPY.notFound)} size="page" />
      ) : q.status === "error" ? (
        <EmptyState
          text={t(COPY.loadFailed)}
          action={{ label: t(COPY.retry), variant: "default", onSelect: q.refetch }}
          size="page"
        />
      ) : data === undefined ? (
        <FormSection
          id="loading"
          title={t(SECTIONS.find((s) => s.id === section)?.label ?? COPY.members)}
          loading={{ fields: 3 }}
        />
      ) : (
        <>
          {data.project.archived ? (
            <Text variant="small" tone="muted">
              {t(COPY.archivedBanner)}
            </Text>
          ) : (
            !data.canEdit && (
              <Text variant="small" tone="muted">
                {t(COPY.readOnly)}
              </Text>
            )
          )}
          {section === "general" && (
            <GeneralSection key={`${data.project.id}-${data.project.archived}`} data={data} />
          )}
          {/* An archived project is read-only: only its archive switch stays usable. */}
          {section === "members" && <MembersSection data={readOnlyWhenArchived(data)} />}
          {section === "types" && <TypesSection data={readOnlyWhenArchived(data)} />}
          {section === "gates" && <GatesSection data={readOnlyWhenArchived(data)} />}
          {section === "defaults" && <DefaultsSection data={readOnlyWhenArchived(data)} />}
        </>
      )}
    </SettingsPage>
  );
}

/** The settings as a read-only view while the project is archived. */
function readOnlyWhenArchived(data: ProjectSettingsResult): ProjectSettingsResult {
  if (!data.project.archived) return data;
  return {
    ...data,
    canEdit: false,
    members: data.members.map((m) => ({ ...m, canSetAgent: false })),
  };
}

/**
 * The project's name, description and archive flag (project owners). Only changed fields are
 * sent, so a form opened before someone archived the project cannot unarchive it by accident;
 * while archived, only the archive switch is usable.
 */
function GeneralSection({ data }: { data: ProjectSettingsResult }) {
  const t = useT();
  const act = useCollabAction();
  const runner = useActionRunner();
  const [name, setName] = useState(data.project.name);
  const [description, setDescription] = useState(data.project.description);
  const [archived, setArchived] = useState(data.project.archived);
  const dirty =
    name.trim() !== data.project.name ||
    description.trim() !== data.project.description ||
    archived !== data.project.archived;
  const locked = data.project.archived;
  const save = () =>
    void runner.run("save", () =>
      act("settings.save", {
        projectId: data.project.id,
        ...(name.trim() !== data.project.name && { name: name.trim() }),
        ...(description.trim() !== data.project.description && {
          description: description.trim(),
        }),
        ...(archived !== data.project.archived && { archived }),
      }),
    );
  return (
    <FormSection id="general" title={t(COPY.general)}>
      <Field label={t(COPY.projectName)} required>
        <Input
          aria-label={t(COPY.projectName)}
          value={name}
          disabled={locked}
          invalid={name.trim() === ""}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t(COPY.description)} optional>
        <Textarea
          aria-label={t(COPY.description)}
          value={description}
          disabled={locked}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label={t(COPY.archived)} help={t(COPY.archivedHelp)}>
        <Switch label={t(COPY.archived)} checked={archived} onChange={setArchived} />
      </Field>
      <ErrorLine error={runner.error} />
      <Stack direction="row" justify="end">
        <Button
          variant="primary"
          disabled={!dirty || name.trim() === ""}
          loading={runner.busy !== null}
          onClick={save}
        >
          {t(COPY.save)}
        </Button>
      </Stack>
    </FormSection>
  );
}

function MembersSection({ data }: { data: ProjectSettingsResult }) {
  const t = useT();
  const act = useCollabAction();
  const remover = useActionRunner();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const isOwnerRow = (m: MemberRow) => m.person.id === data.project.owner.id;
  return (
    <FormSection
      id="members"
      title={t(COPY.members)}
      flush
      {...(data.canEdit && {
        marks: <Button onClick={() => setAdding(true)}>{t(COPY.addMember)}</Button>,
      })}
    >
      <ErrorLine error={remover.error} />
      <TruncatedNote truncated={data.truncated} />
      <DataTable<MemberRow>
        label={t(COPY.members)}
        rows={data.members}
        rowKey={(m) => m.person.id}
        // an owner edits every row; anyone else only reaches their own default agent (row menu)
        {...(data.canEdit && { onOpen: (m: MemberRow) => setEditing(m) })}
        rowMenu={(m: MemberRow) => [
          ...(data.canEdit || m.canSetAgent
            ? [{ label: t(COPY.edit), onSelect: () => setEditing(m) }]
            : []),
          ...(data.canEdit && !isOwnerRow(m)
            ? [{ label: t(COPY.removeMember), danger: true, onSelect: () => setRemoving(m) }]
            : []),
        ]}
        columns={[
          {
            key: "person",
            header: t(COPY.name),
            compact: "title",
            cell: (m) => (
              <PersonName
                name={m.person.name}
                avatarUrl={imageAvatar(m.person.avatar)?.src ?? null}
                size={16}
              />
            ),
          },
          {
            key: "role",
            header: t(COPY.role),
            compact: "subtitle",
            cell: (m) => <Badge>{t(ROLE_LABEL[m.role])}</Badge>,
          },
          {
            key: "function",
            header: t(COPY.functionLabel),
            compact: "meta",
            cell: (m) => m.functionLabel ?? <Text tone="faint">{t(COPY.none)}</Text>,
          },
          {
            key: "agent",
            header: t(COPY.defaultAgent),
            compact: "hidden",
            cell: (m) => m.defaultAgent?.name ?? <Text tone="faint">{t(COPY.none)}</Text>,
          },
        ]}
      />
      {adding && <AddMemberDialog data={data} onClose={() => setAdding(false)} />}
      {removing !== null && (
        <DangerConfirm
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t(COPY.removeMemberTitle)}
          description={t(COPY.removeMemberText)}
          confirmName={removing.person.name}
          confirmLabel={t(COPY.removeMember)}
          confirmDisabled={remover.busy !== null}
          onConfirm={async () => {
            const member = removing;
            setRemoving(null);
            await remover.run("remove", () =>
              act("member.remove", { projectId: data.project.id, accountId: member.person.id }),
            );
          }}
        />
      )}
      {editing !== null && (
        <MemberDialog data={data} member={editing} onClose={() => setEditing(null)} />
      )}
    </FormSection>
  );
}

function roleOptions(t: (c: Copy) => string): SelectOption[] {
  return (["owner", "member", "guest"] as const).map((r) => ({
    value: r,
    label: t(ROLE_LABEL[r]),
  }));
}

function AddMemberDialog({ data, onClose }: { data: ProjectSettingsResult; onClose(): void }) {
  const t = useT();
  const act = useCollabAction();
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState<PersonRef | null>(null);
  const [role, setRole] = useState<ProjectRole>("member");
  const [fn, setFn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // org members (no project filter): the people who may join
  const q = useCollabQuery("people.search", { query }, { staleMs: 30_000 });
  const taken = new Set(data.members.map((m) => m.person.id));
  const people = (q.data !== undefined && !isNotFound(q.data) ? q.data.people : []).filter(
    (p) => !taken.has(p.id),
  );
  const save = async () => {
    if (person === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await act("member.add", {
        projectId: data.project.id,
        accountId: person.id,
        role,
        functionLabel: fn.trim() === "" ? null : fn.trim(),
      });
      if (r.toast === undefined) onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(COPY.addMember)}
      size={480}
      footer={
        <>
          <Button onClick={onClose}>{t(COPY.cancel)}</Button>
          <Button
            variant="primary"
            disabled={person === null}
            loading={busy}
            onClick={() => void save()}
          >
            {t(COPY.addMember)}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <Field label={t(COPY.name)} required>
          <PrincipalPicker
            aria-label={t(COPY.name)}
            options={people.map(personOption)}
            value={person === null ? [] : [person.id]}
            loading={q.status === "loading"}
            onSearch={setQuery}
            onChange={(ids) => setPerson(people.find((p) => p.id === ids[0]) ?? null)}
          />
        </Field>
        <Field label={t(COPY.role)}>
          <Select
            aria-label={t(COPY.role)}
            value={role}
            options={roleOptions(t)}
            onChange={(e) => setRole(e.target.value as ProjectRole)}
          />
        </Field>
        <Field label={t(COPY.functionLabel)} optional>
          <Input
            aria-label={t(COPY.functionLabel)}
            value={fn}
            onChange={(e) => setFn(e.target.value)}
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

/** A member's role and function (project owners) and default agent (owners or themselves). */
function MemberDialog(props: { data: ProjectSettingsResult; member: MemberRow; onClose(): void }) {
  const t = useT();
  const act = useCollabAction();
  const { data, member } = props;
  const [role, setRole] = useState<ProjectRole>(member.role);
  const [fn, setFn] = useState(member.functionLabel ?? "");
  const [agent, setAgent] = useState<AgentRef | null>(member.defaultAgent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useCollabQuery(
    "agents.usable",
    { project: data.project.key, accountId: member.person.id },
    { staleMs: 30_000 },
  );
  const agents = q.data !== undefined && !isNotFound(q.data) ? q.data.agents : [];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (data.canEdit && role !== member.role) {
        const r = await act("member.add", {
          projectId: data.project.id,
          accountId: member.person.id,
          role,
        });
        if (r.toast !== undefined) return;
      }
      const nextFn = fn.trim() === "" ? null : fn.trim();
      const fnChanged = data.canEdit && nextFn !== member.functionLabel;
      const agentChanged =
        member.canSetAgent && (agent?.id ?? null) !== (member.defaultAgent?.id ?? null);
      if (fnChanged || agentChanged) {
        const r = await act("member.function", {
          projectId: data.project.id,
          accountId: member.person.id,
          ...(fnChanged && { functionLabel: nextFn }),
          ...(agentChanged && { defaultAgentId: agent?.id ?? null }),
        });
        if (r.toast !== undefined) return;
      }
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && props.onClose()}
      title={member.person.name}
      size={480}
      footer={
        <>
          <Button onClick={props.onClose}>{t(COPY.cancel)}</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t(COPY.save)}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        {data.canEdit && member.person.id !== data.project.owner.id && (
          <Field label={t(COPY.role)}>
            <Select
              aria-label={t(COPY.role)}
              value={role}
              options={roleOptions(t)}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
            />
          </Field>
        )}
        {data.canEdit && (
          <Field label={t(COPY.functionLabel)} optional>
            <Input
              aria-label={t(COPY.functionLabel)}
              value={fn}
              onChange={(e) => setFn(e.target.value)}
            />
          </Field>
        )}
        {member.canSetAgent && (
          <Field
            label={t(COPY.defaultAgent)}
            optional
            action={
              agent === null ? null : (
                <Button variant="ghost" onClick={() => setAgent(null)}>
                  {t(COPY.noAgent)}
                </Button>
              )
            }
          >
            <PrincipalPicker
              aria-label={t(COPY.defaultAgent)}
              options={agents.map(agentOption)}
              value={agent === null ? [] : [agent.id]}
              loading={q.status === "loading"}
              onChange={(ids) => setAgent(agents.find((a) => a.id === ids[0]) ?? null)}
            />
          </Field>
        )}
        {error !== null && (
          <Text variant="small" tone="fail">
            {error}
          </Text>
        )}
      </Stack>
    </Dialog>
  );
}

function TypesSection({ data }: { data: ProjectSettingsResult }) {
  const t = useT();
  return (
    <>
      {data.types.map((ty) => (
        <FormSection key={ty.key} id={`type-${ty.key}`} title={t(ty.name)} flush>
          <ItemList label={`${t(COPY.workflow)} ${t(ty.name)}`}>
            {ty.statuses.map((s) => (
              <ItemListItem
                key={s.key}
                title={t(s.name)}
                code={s.key}
                tag={{ label: t(CATEGORY_LABEL[s.category] ?? COPY.none) }}
                meta={
                  s.next.length === 0
                    ? undefined
                    : `→ ${s.next.map((k) => statusName(ty, k, t)).join(", ")}`
                }
                {...(s.gate !== null && { marks: <Badge tone="warn">{t(COPY.gate)}</Badge> })}
              />
            ))}
          </ItemList>
        </FormSection>
      ))}
    </>
  );
}

function statusName(ty: TypeSettings, key: string, t: (c: Copy) => string): string {
  const s = ty.statuses.find((x) => x.key === key);
  return s === undefined ? key : t(s.name);
}

/** The function labels the project's members carry (default assignments and gates name them). */
function functionLabels(data: ProjectSettingsResult): string[] {
  return [
    ...new Set(data.members.map((m) => m.functionLabel).filter((f): f is string => f !== null)),
  ];
}

function encodeGate(g: GateRule | null): string {
  if (g === null) return "none";
  if (g.confirmer === "member") return `member:${g.accountId}`;
  if (g.confirmer === "function") return `function:${g.functionLabel}`;
  return g.confirmer;
}

function decodeGate(v: string): GateRule | null {
  if (v === "requester" || v === "responsible" || v === "owner") return { confirmer: v };
  if (v.startsWith("member:")) return { confirmer: "member", accountId: v.slice(7) };
  if (v.startsWith("function:")) return { confirmer: "function", functionLabel: v.slice(9) };
  return null;
}

/** Saves one status's patch; refusals are the host's toast, failures show in `error`. */
function useSaveStatus(data: ProjectSettingsResult): {
  save(patch: StatusSettingsPatch): void;
  error: string | null;
} {
  const act = useCollabAction();
  const runner = useActionRunner();
  return {
    save: (patch) =>
      void runner.run("save", () =>
        act("settings.save", { projectId: data.project.id, statuses: [patch] }),
      ),
    error: runner.error,
  };
}

function GatesSection({ data }: { data: ProjectSettingsResult }) {
  const t = useT();
  const { save, error } = useSaveStatus(data);
  const options: SelectOption[] = [
    { value: "none", label: t(COPY.noGates) },
    { value: "requester", label: t({ zh: "提出人", en: "Requester" }) },
    { value: "responsible", label: t(COPY.responsible) },
    { value: "owner", label: t(ROLE_LABEL.owner) },
    ...functionLabels(data).map((f) => ({
      value: `function:${f}`,
      label: `${t(COPY.functionLabel)}: ${f}`,
    })),
    ...data.members
      .filter((m) => m.role !== "guest")
      .map((m) => ({ value: `member:${m.person.id}`, label: m.person.name })),
  ];
  return (
    <>
      <ErrorLine error={error} />
      {data.types.map((ty) => (
        <FormSection key={ty.key} id={`gates-${ty.key}`} title={t(ty.name)}>
          {ty.statuses.map((s) => (
            <Field key={s.key} label={t(s.name)} help={t(COPY.confirmer)}>
              <Select
                aria-label={`${t(ty.name)} ${t(s.name)} ${t(COPY.confirmer)}`}
                value={encodeGate(s.gate)}
                options={withCurrent(options, encodeGate(s.gate), t(COPY.unknownMember))}
                disabled={!data.canEdit}
                onChange={(e) =>
                  save({ type: ty.key, key: s.key, gate: decodeGate(e.target.value) })
                }
              />
            </Field>
          ))}
        </FormSection>
      ))}
    </>
  );
}

/** Keeps a stored value that matches no option (a member who left) selectable, unnamed. */
function withCurrent(options: SelectOption[], value: string, unknown: string): SelectOption[] {
  return options.some((o) => o.value === value) ? options : [...options, { value, label: unknown }];
}

function encodeAssignee(d: DefaultAssignmentRule | null): string {
  if (d === null) return "none";
  if (d.accountId !== undefined) return `member:${d.accountId}`;
  if (d.functionLabel !== undefined) return `function:${d.functionLabel}`;
  return "none";
}

function DefaultsSection({ data }: { data: ProjectSettingsResult }) {
  const t = useT();
  const { save, error } = useSaveStatus(data);
  const options: SelectOption[] = [
    { value: "none", label: t(COPY.noDefaults) },
    ...functionLabels(data).map((f) => ({
      value: `function:${f}`,
      label: `${t(COPY.functionLabel)}: ${f}`,
    })),
    ...data.members
      .filter((m) => m.role !== "guest")
      .map((m) => ({ value: `member:${m.person.id}`, label: m.person.name })),
  ];
  const patch = (ty: TypeSettings, s: StatusInfo, assignee: string, memberAgent: boolean) => {
    // a fixed agent stays unless the member's own agent replaces it
    const agentId = memberAgent ? undefined : s.defaultAssignment?.agentId;
    const extra = {
      ...(memberAgent && { memberAgent: true }),
      ...(agentId !== undefined && { agentId }),
    };
    const rule: DefaultAssignmentRule | null = assignee.startsWith("member:")
      ? { accountId: assignee.slice(7), ...extra }
      : assignee.startsWith("function:")
        ? { functionLabel: assignee.slice(9), ...extra }
        : null;
    save({ type: ty.key, key: s.key, defaultAssignment: rule });
  };
  return (
    <>
      <ErrorLine error={error} />
      {data.types.map((ty) => (
        <FormSection key={ty.key} id={`defaults-${ty.key}`} title={t(ty.name)}>
          {ty.statuses.map((s) => {
            const value = encodeAssignee(s.defaultAssignment);
            const memberAgent = s.defaultAssignment?.memberAgent === true;
            return (
              <Field key={s.key} label={t(s.name)} help={t(COPY.assignee)}>
                <Stack direction="row" gap={8} align="center">
                  <Select
                    aria-label={`${t(ty.name)} ${t(s.name)} ${t(COPY.assignee)}`}
                    value={value}
                    options={withCurrent(options, value, t(COPY.unknownMember))}
                    disabled={!data.canEdit}
                    onChange={(e) => patch(ty, s, e.target.value, memberAgent)}
                  />
                  <Switch
                    label={t({ zh: "同时交给其默认智能体", en: "Also their default agent" })}
                    checked={memberAgent}
                    disabled={!data.canEdit || value === "none"}
                    onChange={(next) => patch(ty, s, value, next)}
                  />
                </Stack>
              </Field>
            );
          })}
        </FormSection>
      ))}
    </>
  );
}
