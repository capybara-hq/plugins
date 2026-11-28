import {
  Badge,
  Button,
  CellTitle,
  DataTable,
  Dialog,
  Field,
  Input,
  ListPage,
  PersonName,
  Text,
  Textarea,
  useNavigate,
} from "@capybara-hq/plugin-client";
import { useState } from "react";
import type { ProjectRow } from "../page/contract.js";
import { COPY, ROLE_LABEL } from "./i18n.js";
import {
  avatarUrl,
  errorText,
  TruncatedNote,
  useCollabAction,
  useCollabQuery,
  useT,
} from "./shared.js";

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** The projects the viewer is a member of (no page params). */
export function ProjectsList() {
  const t = useT();
  const navigate = useNavigate();
  const q = useCollabQuery("projects.list", {});
  const [creating, setCreating] = useState(false);
  const data = q.data;
  const rows = data?.projects ?? [];

  return (
    <ListPage
      header={{
        title: t(COPY.projects),
        ...(data !== undefined && { count: rows.length }),
        actions:
          data?.canCreate === true
            ? [{ label: t(COPY.newProject), variant: "primary", onSelect: () => setCreating(true) }]
            : [],
      }}
      listLabel={t(COPY.projectsLabel)}
      loading={q.status === "loading"}
    >
      <TruncatedNote truncated={data?.truncated} />
      <DataTable<ProjectRow>
        label={t(COPY.projectsLabel)}
        state={q.status === "error" ? "error" : q.status === "loading" ? "loading" : "ready"}
        error={{ code: q.error ?? "ui.query_failed", onRetry: q.refetch }}
        rows={rows}
        rowKey={(r) => r.id}
        onOpen={(r) => navigate({ params: { project: r.key } })}
        empty={{ title: t(COPY.noProjects), hint: t(COPY.noProjectsHint) }}
        columns={[
          {
            key: "name",
            header: t(COPY.name),
            compact: "title",
            cell: (r) => <CellTitle title={r.name} description={r.description} trailing={r.key} />,
          },
          {
            key: "owner",
            header: t(ROLE_LABEL.owner),
            compact: "meta",
            cell: (r) => (
              <PersonName name={r.owner.name} avatarUrl={avatarUrl(r.owner.avatar)} size={16} />
            ),
          },
          {
            key: "role",
            header: t(COPY.role),
            compact: "hidden",
            cell: (r) => <Badge>{t(ROLE_LABEL[r.role])}</Badge>,
          },
          {
            key: "open",
            header: t(COPY.openItems),
            align: "right",
            compact: "trailing",
            cell: (r) => String(r.openItems),
          },
        ]}
      />
      <ProjectCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(key) => navigate({ params: { project: key } })}
      />
    </ListPage>
  );
}

function ProjectCreateDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(key: string): void;
}) {
  const t = useT();
  const act = useCollabAction();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyOk = KEY_RE.test(key);
  const valid = keyOk && name.trim() !== "";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act("project.create", {
        key,
        name: name.trim(),
        ...(description.trim() !== "" && { description: description.trim() }),
      });
      // a refusal is the host's toast; the dialog stays for a fix
      if (r.toast === undefined) {
        props.onOpenChange(false);
        props.onCreated(key);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t(COPY.newProject)}
      size={480}
      footer={
        <>
          <Button onClick={() => props.onOpenChange(false)}>{t(COPY.cancel)}</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void submit()}>
            {t(COPY.create)}
          </Button>
        </>
      }
    >
      <Field label={t(COPY.projectKey)} required help={t(COPY.projectKeyHelp)}>
        <Input
          aria-label={t(COPY.projectKey)}
          value={key}
          maxLength={10}
          invalid={key !== "" && !keyOk}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
        />
      </Field>
      <Field label={t(COPY.projectName)} required>
        <Input
          aria-label={t(COPY.projectName)}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t(COPY.description)} optional>
        <Textarea
          aria-label={t(COPY.description)}
          value={description}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {error !== null && (
        <Text variant="small" tone="fail">
          {error}
        </Text>
      )}
    </Dialog>
  );
}
