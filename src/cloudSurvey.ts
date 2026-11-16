import { useEffect, useState } from "react";
import type { Query } from "./types";

export const cloudMetrics = [
  ["discovered", "Archive products discovered"],
  ["preprocessed", "Unique products preprocessed"],
  ["compatible_groups", "Compatible multi-epoch groups"],
  ["searched_groups", "Groups searched for motion"],
  ["moving_candidates", "Moving-object trial peaks"],
  ["known_matches", "Known-object matches"],
  ["rejected_artifacts", "Rejected artifacts"],
  ["unresolved_candidates", "Unresolved candidates"],
  ["confirmed_discoveries", "Independently confirmed discoveries"],
] as const;

export type CloudCandidate = {
  id: string;
  group_id: string;
  ra: number;
  dec: number;
  classification: string;
  evidence: Record<string, unknown>;
};

export type CloudSnapshot = {
  worker_status: string;
  last_successful_run: string | null;
  latest_checkpoint: string | null;
  metrics: Record<(typeof cloudMetrics)[number][0], number>;
  recent_candidates: CloudCandidate[];
  latest_run: {
    started_at: string;
    finished_at: string | null;
    status: string;
    reason: string | null;
    usage: Record<string, unknown>;
  } | null;
};

export type CloudJob = Query & {
  job_id: string;
  state: "queued" | "running" | "searched" | "insufficient" | "retry" | "blocked";
  attempts: number;
  requested_at: string;
  updated_at: string;
  group_id: string | null;
  message: string | null;
  retry_at: string | null;
  candidates: CloudCandidate[];
};

export type CloudSession = { access_token: string; expires_at: number };

export const cloudJobParam = "cloudJob";
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function initialCloudJobId() {
  const value = new URLSearchParams(location.search).get(cloudJobParam);
  return value && uuid.test(value) ? value : null;
}

async function callCloud<T>(
  path: string,
  options: { data?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const { data, token, signal } = options;
  const headers = new Headers({ Accept: "application/json" });
  if (data !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(`/api/cloud-survey${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new Error("The remote survey connection failed. Try again later.");
  }
  if (!response.ok) {
    if (path === "/sign-in" && response.status < 500 && response.status !== 429)
      throw new Error("Sign-in failed. Check the survey owner's email and password.");
    if (token && (response.status === 401 || response.status === 403))
      throw new Error("Only the authorized survey owner can queue a search. Sign in again if your session expired.");
    if (response.status === 429)
      throw new Error("The remote survey has reached a limit. Try again later.");
    throw new Error("The remote survey could not respond. Try again later.");
  }
  return response.json() as Promise<T>;
}

export function useCloudConnection(enabled = true) {
  const [connection, setConnection] = useState<"checking" | "connected" | "unconfigured" | "unavailable">("checking");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void callCloud<{ connected: boolean }>("/config", { signal: controller.signal })
      .then(({ connected }) => setConnection(connected ? "connected" : "unconfigured"))
      .catch(() => {
        if (!controller.signal.aborted) setConnection("unavailable");
      });
    return () => controller.abort();
  }, [enabled]);
  return connection;
}

export function getCloudSnapshot(signal: AbortSignal) {
  return callCloud<CloudSnapshot>("/status", { signal });
}

export function getCloudJob(id: string, signal: AbortSignal) {
  return callCloud<CloudJob | null>(`/detection/${encodeURIComponent(id)}`, { signal });
}

export async function signInCloudOwner(email: string, password: string) {
  const result = await callCloud<{
    access_token?: string;
    expires_at?: number;
    expires_in?: number;
  }>("/sign-in", { data: { email, password } });
  if (!result.access_token)
    throw new Error("Supabase did not return an owner session.");
  return {
    access_token: result.access_token,
    expires_at: result.expires_at ?? Math.floor(Date.now() / 1000) + (result.expires_in ?? 0),
  };
}

export function queueCloudJob(field: Query, token: string) {
  return callCloud<CloudJob>("/detection", { data: field, token });
}

const utc = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function cloudTime(value: string | null | undefined) {
  if (!value) return "—";
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) ? `${utc.format(timestamp)} UTC` : "—";
}

export const workerLabels: Record<string, string> = {
  configured: "Awaiting first run",
  running: "Running",
  interrupted: "Interrupted",
  completed: "Between sessions",
  paused: "Paused",
  error: "Worker error",
  storage_limit: "Paused at storage limit",
};

export const jobLabels: Record<CloudJob["state"], string> = {
  queued: "Waiting for the next worker session",
  running: "Field search in progress",
  searched: "Motion search complete",
  insufficient: "Insufficient compatible observations",
  retry: "Waiting for a retry",
  blocked: "Search blocked",
};
