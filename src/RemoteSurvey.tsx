import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowDownToLine } from "lucide-react";
import {
  cloudMetrics,
  cloudTime,
  getCloudJob,
  getCloudSnapshot,
  initialCloudJobId,
  jobLabels,
  useCloudConnection,
  workerLabels,
} from "./cloudSurvey";
import type { CloudCandidate } from "./cloudSurvey";
import { download, fmt } from "./lib";
import "./cloud-survey.css";

const number = new Intl.NumberFormat();
const classifications: Record<string, string> = {
  unresolved: "Unresolved",
  known_match: "Known-object match",
  artifact: "Rejected artifact",
  insufficient: "Insufficient evidence",
  "insufficient-evidence": "Insufficient evidence",
};

function useCloudRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  pollMs = 0,
  settled?: (value: T) => boolean,
) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let finished = false;
    async function lookup() {
      let failed = false;
      try {
        const value = await read(controller.signal);
        finished = settled?.(value) ?? false;
        if (!controller.signal.aborted) {
          setData(value);
          setError(false);
        }
      } catch {
        failed = true;
        if (!controller.signal.aborted) setError(true);
      }
      if (!controller.signal.aborted && !finished && pollMs > 0) {
        timer = window.setTimeout(() => {
          if (document.visibilityState === "visible") void lookup();
        }, failed ? Math.max(pollMs, 300_000) : pollMs);
      }
    }
    function onVisible() {
      if (!finished && document.visibilityState === "visible") setRefresh((value) => value + 1);
    }
    void lookup();
    if (pollMs) document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read, refresh, pollMs, settled]);
  return { data, error, reload: () => setRefresh((value) => value + 1) };
}

export default function RemoteSurvey() {
  const jobId = initialCloudJobId();
  const connection = useCloudConnection();
  return (
    <section className="remote-survey" aria-label="Kaggle survey records">
      <div className="stats-intro">
        <div>
          <span className="stats-kicker"><Activity size={15} aria-hidden="true" /> Remote survey</span>
          <h2>SPHEREx archive search</h2>
          <p>Committed Kaggle results for DR1 and QR3. Earlier published survey runs are shown in the Large archive survey tab.</p>
        </div>
      </div>
      {connection === "connected" ? <RemoteSurveyRecords jobId={jobId} /> : (
        <div className="stats-notice" role="status">
          {connection === "checking" ? "Checking the remote survey…" :
            connection === "unavailable" ? "The remote survey is temporarily unavailable." :
              "The remote survey database has not been connected to this deployment."}
        </div>
      )}
    </section>
  );
}

function RemoteSurveyRecords({ jobId }: { jobId: string | null }) {
  const { data, error, reload } = useCloudRead(getCloudSnapshot, 60_000);
  return (
    <>
      {jobId && <CloudFieldSearch key={jobId} jobId={jobId} />}
      <div className="stats-toolbar">
        <span>Worker status · {data ? workerLabels[data.worker_status] ?? data.worker_status : error ? "Unavailable" : "Loading…"}</span>
        <button type="button" className="stats-button" onClick={reload}>Refresh results</button>
      </div>
      {error && (
        <p className="stats-notice" role="status">
          The remote database could not respond. {data ? "Showing the last retrieved snapshot." : "Refresh to try again."}
        </p>
      )}
      {!data && !error && <p className="stats-notice" role="status">Loading committed survey results…</p>}
      {data && (
        <>
          <dl className="remote-checkpoint">
            <div><dt>Last successful session</dt><dd>{cloudTime(data.last_successful_run)}</dd></div>
            <div><dt>Latest committed checkpoint</dt><dd>{cloudTime(data.latest_checkpoint)}</dd></div>
            <div><dt>Latest session started</dt><dd>{cloudTime(data.latest_run?.started_at)}</dd></div>
          </dl>
          {data.latest_run?.reason && <p className="stats-plot-note">{data.latest_run.reason}</p>}
          {data.latest_run && <RunUsage usage={data.latest_run.usage} />}
          <dl className="remote-metrics" aria-label="Remote survey totals">
            {cloudMetrics.map(([key, label]) => (
              <div className="stats-metric" key={key}>
                <dt>{label}</dt>
                <dd>{Number.isSafeInteger(data.metrics?.[key]) ? number.format(data.metrics[key]) : "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="stats-plot-note">
            A motion search compares overlapping observations from different times. A retained peak requires scientific review.
          </p>
          <CandidateRecords candidates={data.recent_candidates} title="Recent saved candidates" />
          <div>
            <button type="button" className="stats-button" onClick={() => download("slowtrace-remote-survey.json", data)}>
              <ArrowDownToLine size={15} aria-hidden="true" /> Download survey snapshot
            </button>
          </div>
        </>
      )}
    </>
  );
}

const duration = (value: unknown) => typeof value === "number" ? `${fmt(value, 1)} s` : "—";
const mib = (value: unknown) => typeof value === "number" ? `${fmt(value / 2 ** 20, 1)} MiB` : "—";

function RunUsage({ usage }: { usage: Record<string, unknown> | undefined }) {
  if (!usage || !Object.keys(usage).length) return null;
  return (
    <details className="remote-candidates">
      <summary>Latest session resource use</summary>
      <dl className="remote-checkpoint">
        <div><dt>CPU time</dt><dd>{duration(usage.cpuSeconds)}</dd></div>
        <div><dt>Elapsed time</dt><dd>{duration(usage.elapsedSeconds)}</dd></div>
        <div><dt>Peak process RAM</dt><dd>{mib(usage.peakRamBytes)}</dd></div>
        <div><dt>Peak temporary files</dt><dd>{mib(usage.peakScratchBytes)}</dd></div>
        <div><dt>NASA archive transferred</dt><dd>{mib(usage.archiveBytes)}</dd></div>
      </dl>
    </details>
  );
}

const fieldFinished = (value: Awaited<ReturnType<typeof getCloudJob>>) =>
  value === null || ["searched", "insufficient", "blocked"].includes(value.state);

function CloudFieldSearch({ jobId }: { jobId: string }) {
  const read = useCallback((signal: AbortSignal) => getCloudJob(jobId, signal), [jobId]);
  const { data: job, error, reload } = useCloudRead(read, 60_000, fieldFinished);
  return (
    <section className="remote-candidates" aria-label="Requested field search">
      <header>
        <h3>Requested field search</h3>
        <button type="button" className="stats-button" onClick={reload}>Refresh field search</button>
      </header>
      {error && <p role="status">The field search status is temporarily unavailable. {job ? "Showing the last retrieved result." : null}</p>}
      {job === null && !error && <p role="status">No published field search matches this link.</p>}
      {job === undefined && !error && <p role="status">Loading field search…</p>}
      {job && (
        <>
          <p role="status">
            {jobLabels[job.state] ?? job.state} · {job.ra.toFixed(5)}°, {job.dec.toFixed(5)}° · {job.fov}′ · {job.detector ? `D${job.detector}` : "Automatic detector"}
          </p>
          <p>Updated {cloudTime(job.updated_at)} · {number.format(job.attempts)} worker attempts</p>
          {job.message && <p>{job.message}</p>}
          {job.retry_at && job.state === "retry" && <p>Retry eligible {cloudTime(job.retry_at)}</p>}
          {job.state === "searched" && (
            <CandidateRecords candidates={job.candidates} title="Saved candidates in this field" />
          )}
          <button type="button" className="stats-button" onClick={() => download(`slowtrace-${job.job_id}.json`, job)}>
            <ArrowDownToLine size={15} aria-hidden="true" /> Download field record
          </button>
        </>
      )}
    </section>
  );
}

function CandidateRecords({ candidates, title }: { candidates: CloudCandidate[]; title: string }) {
  if (!Array.isArray(candidates)) return null;
  return (
    <section className="remote-candidates">
      <header><h3>{title}</h3></header>
      {candidates.length ? (
        <>
          <p>Coordinates are ICRS. The table shows a limited set of published records.</p>
          <div className="remote-table-scroll" tabIndex={0} role="region" aria-label={title}>
            <table>
              <thead><tr><th scope="col">Record</th><th scope="col">RA / Dec</th><th scope="col">Nominal S/N</th><th scope="col">Review</th></tr></thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.id}>
                    <td>{candidate.id}</td>
                    <td>
                      <a href={`?page=observe&ra=${candidate.ra}&dec=${candidate.dec}&fov=5&detector=0`} title="Open the archive at this trial position">
                        {fmt(candidate.ra, 5)}°, {fmt(candidate.dec, 5)}°
                      </a>
                    </td>
                    <td>{typeof candidate.evidence?.nominalSnr === "number" ? fmt(candidate.evidence.nominalSnr, 1) : "—"}</td>
                    <td>{classifications[candidate.classification] ?? "Review pending"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <p>There are no saved candidates in this record.</p>}
    </section>
  );
}
