import { ModelError } from "@capybara-hq/plugin-sdk";
import { fetchError, kindFromStatus, retryAfterMs } from "./errors.js";
import { signV4 } from "./sign.js";

const PAGE_SIZE = 100;
/** A safety stop: 50 pages of 100 endpoints. */
const MAX_PAGES = 50;
const TIMEOUT_MS = 30_000;

export interface Management {
  accessKeyId: string;
  secretAccessKey: string;
}

/** One inference endpoint (`ep-…`) of the account, reduced to what the list needs. */
export interface ArkEndpoint {
  id: string;
  name: string;
  /** The foundation model it serves (`ModelReference.FoundationModel`). */
  model: { name: string; version: string } | null;
  status: string;
}

interface RawEndpoint {
  Id?: unknown;
  Name?: unknown;
  Status?: unknown;
  ModelReference?: { FoundationModel?: { Name?: unknown; ModelVersion?: unknown } | null } | null;
}

interface RawPage {
  ResponseMetadata?: { Error?: { Code?: unknown; Message?: unknown } | null } | null;
  Result?: { TotalCount?: unknown; Items?: unknown } | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * `ListEndpoints` (Version 2024-01-01) on the control plane, every page, signed with the
 * management AK/SK (live 2026-11-08: allowed for a sub-user with ArkReadOnlyAccess; item fields
 * `Id`, `Name`, `Status`, `ModelReference.FoundationModel { Name, ModelVersion }`, …).
 */
export async function listEndpoints(
  controlPlaneUrl: string,
  region: string,
  management: Management,
  now: () => Date = () => new Date(),
): Promise<ArkEndpoint[]> {
  const url = new URL(controlPlaneUrl);
  const out: ArkEndpoint[] = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = { Action: "ListEndpoints", Version: "2024-01-01" };
    const body = JSON.stringify({ PageNumber: page, PageSize: PAGE_SIZE });
    const signed = signV4({
      method: "POST",
      host: url.host,
      path: "/",
      query,
      body,
      accessKeyId: management.accessKeyId,
      secretAccessKey: management.secretAccessKey,
      region,
      service: "ark",
      now: now(),
    });
    const target = new URL("/", url);
    for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(target, {
        method: "POST",
        headers: { ...signed.headers, accept: "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw fetchError(cause, "listing endpoints");
    }
    let raw: RawPage = {};
    try {
      raw = (await res.json()) as RawPage;
    } catch {
      // not JSON: judged by the status below
    }
    const err = raw.ResponseMetadata?.Error;
    if (!res.ok || err != null) {
      const code = str(err?.Code);
      const kind = res.ok ? "server" : kindFromStatus(res.status, code);
      const ms = kind === "rate_limited" ? retryAfterMs(res.headers) : undefined;
      throw new ModelError(
        kind,
        `Ark: listing endpoints: ${code || `HTTP ${res.status}`} ${str(err?.Message)}`.trim(),
        ms !== undefined ? { retryAfterMs: ms } : {},
      );
    }
    const items = Array.isArray(raw.Result?.Items) ? (raw.Result?.Items as unknown[]) : [];
    for (const it of items) {
      if (typeof it !== "object" || it === null) continue;
      const e = it as RawEndpoint;
      const id = str(e.Id);
      if (id === "") continue;
      const fm = e.ModelReference?.FoundationModel;
      const fmName = str(fm?.Name);
      out.push({
        id,
        name: str(e.Name) || id,
        model: fmName !== "" ? { name: fmName, version: str(fm?.ModelVersion) } : null,
        status: str(e.Status),
      });
    }
    seen += items.length;
    // a missing TotalCount is unknown: page on until a short page (MAX_PAGES bounds it)
    const total = typeof raw.Result?.TotalCount === "number" ? raw.Result.TotalCount : undefined;
    if (items.length < PAGE_SIZE || (total !== undefined && seen >= total)) break;
  }
  return out;
}
