import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ExternalLink,
  Globe2,
  Orbit,
  LoaderCircle,
  Radar,
  ShieldCheck,
  Telescope,
} from "lucide-react";
import { date, download, fmt, post, request } from "./lib";
import { useBulkSurvey } from "./bulkSurvey";
import CandidatePreview from "./CandidatePreview";
import type { CandidatePreviews } from "./CandidatePreview";
import type {
  Candidate,
  Investigation,
  InvestigationInput,
  SurveySnapshot,
} from "./surveyTypes";

type View =
  "observe" | "trace" | "spectra" | "notebook" | "planner" | "atlas" | "solar";
type Review = { time: string; interpretation: string; note: string };
const readable = (value: string | undefined) =>
  value?.replace(/[-_]/g, " ") || "unavailable";

function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function when(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

export default function SurveyDesk({
  manual,
  onOpen,
}: {
  manual: InvestigationInput | null;
  onOpen: (candidate: Candidate, view: View) => void;
}) {
  const bulk = useBulkSurvey();
  const [snapshot, setSnapshot] = useState<SurveySnapshot | null>(null);
  const [previews, setPreviews] = useState<CandidatePreviews | null>();
  const [snapshotError, setSnapshotError] = useState("");
  const [selected, setSelected] = useState(
    () => new URLSearchParams(location.search).get("candidate") || "",
  );
  const [query, setQuery] = useState("");
  const [classification, setClassification] = useState("");
  const [fieldFilter, setFieldFilter] = useState("");
  const [sort, setSort] = useState("gain");
  const [checkedOnly, setCheckedOnly] = useState(false);
  const [visible, setVisible] = useState(18);
  const [screen, setScreen] = useState<"candidates" | "fields">("candidates");
  const [manualOpen, setManualOpen] = useState(Boolean(manual));
  useEffect(() => {
    const abort = new AbortController();
    request<SurveySnapshot>("/survey.json", {
      signal: abort.signal,
      cache: "no-cache",
    })
      .then(setSnapshot)
      .catch((error) => {
        if (!abort.signal.aborted) setSnapshotError(error.message);
      });
    request<CandidatePreviews>("/candidate-previews.json", {
      signal: abort.signal,
    })
      .then(setPreviews)
      .catch(() => {
        if (!abort.signal.aborted) setPreviews(null);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (manual) setManualOpen(true);
  }, [manual]);
  function show(id: string) {
    setSelected(id);
    setManualOpen(false);
    const params = new URLSearchParams({ page: "survey" });
    if (id) params.set("candidate", id);
    history.replaceState(null, "", `?${params}`);
    window.scrollTo(0, 0);
  }
  const selectedCandidate = snapshot?.candidates.find((c) => c.id === selected);
  const site =
    selectedCandidate &&
    snapshot?.fields.find((f) => f.id === selectedCandidate.fieldId);
  const candidate = selectedCandidate && {
    ...selectedCandidate,
    field:
      selectedCandidate.field ??
      (site
        ? { ra: site.ra, dec: site.dec, fov: site.fov, detector: site.detector }
        : undefined),
  };
  if (manualOpen && manual)
    return (
      <CandidateDetail
        key={manual.id ?? "manual"}
        input={manual}
        onBack={() => show("")}
        onOpen={onOpen}
      />
    );
  if (candidate)
    return (
      <CandidateDetail
        key={candidate.id}
        input={candidate}
        candidate={candidate}
        onBack={() => show("")}
        onOpen={onOpen}
      />
    );
  if (!snapshot)
    return (
      <section className="panel tool-panel" role="status">
        {snapshotError ? (
          `Survey records could not be loaded. ${snapshotError}`
        ) : (
          <>
            <LoaderCircle className="spinner" size={16} /> Loading survey
            records…
          </>
        )}
      </section>
    );
  const { summary } = snapshot;
  const needle = query.trim().toLowerCase();
  const matches = snapshot.candidates.filter((c) => {
    const field = snapshot.fields.find((f) => f.id === c.fieldId);
    return (
      (!classification || c.classification === classification) &&
      (!fieldFilter || c.fieldId === fieldFilter) &&
      (!checkedOnly || Boolean(c.catalogInvestigation || c.investigation)) &&
      `${c.id} ${c.fieldId} ${field?.label ?? ""} ${readable(c.classification)} ${c.ra.toFixed(5)} ${c.dec.toFixed(5)}`
        .toLowerCase()
        .includes(needle)
    );
  });
  function speed(c: Candidate) {
    return Math.hypot(
      c.evidence.velocityWestArcsecDay ?? 0,
      c.evidence.velocitySouthArcsecDay ?? 0,
    );
  }
  if (sort === "motion") matches.sort((a, b) => speed(b) - speed(a));
  if (sort === "snr")
    matches.sort(
      (a, b) => (b.evidence.nominalSnr ?? 0) - (a.evidence.nominalSnr ?? 0),
    );
  if (sort === "brightness")
    matches.sort(
      (a, b) =>
        Number(b.evidence.fluxPixelSum ?? 0) -
        Number(a.evidence.fluxPixelSum ?? 0),
    );
  const statusOptions = [
    ...new Set(snapshot.candidates.map((c) => c.classification)),
  ];
  return (
    <section className="panel tool-panel survey-desk">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">
            <Radar size={14} /> AUTOMATED SURVEY
          </span>
          <h2>{snapshot.label}</h2>
          <p className="caption">
            Published {when(snapshot.generatedAt)}. Candidate records reflect
            completed motion searches.
          </p>
          {bulk.snapshot && (
            <p className="caption">
              {bulk.snapshot.summary.uniqueProcessed.toLocaleString()} unique
              detector observations processed in the{" "}
              <a href="/?page=stats">large archive survey</a>.
            </p>
          )}
        </div>
        <button
          className="secondary"
          onClick={() => download("slowtrace-survey.json", snapshot)}
        >
          <ArrowDownToLine size={15} /> Export survey
        </button>
      </div>
      <div className="recovery-grid survey-metrics">
        <Metric
          value={`${summary.fieldsAnalyzed ?? 0} / ${summary.planned ?? snapshot.fields.length}`}
          label="Fields analyzed"
        />
        <Metric
          value={summary.uniqueExposuresAnalyzed}
          label="Distinct exposures analyzed"
        />
        <Metric
          value={summary.usablePixelSamples}
          label="Valid pixel samples analyzed"
        />
        <Metric
          value={summary.candidates ?? snapshot.candidates.length}
          label="Retained candidate peaks"
        />
      </div>
      <div className="survey-status">
        {["queued", "running", "complete", "empty", "incomplete", "errors"].map(
          (name) => (
            <span key={name}>
              {readable(name)} <strong>{summary[name] ?? 0}</strong>
            </span>
          ),
        )}
        <span>
          Processing time <strong>{fmt(summary.elapsedSeconds, 1)} s</strong>
        </span>
        <span title="Configured trial shifts times output cells, including masked cells. This is a workload count.">
          Trial grid cells{" "}
          <strong>{summary.trialGridPositions?.toLocaleString() ?? "—"}</strong>
        </span>
      </div>
      <div className="survey-controls">
        <div className="segmented">
          <button
            className={screen === "candidates" ? "selected" : ""}
            onClick={() => setScreen("candidates")}
          >
            Candidates
          </button>
          <button
            className={screen === "fields" ? "selected" : ""}
            onClick={() => setScreen("fields")}
          >
            Fields and attempts
          </button>
        </div>
        {screen === "candidates" && (
          <>
            <input
              aria-label="Search candidates"
              placeholder="Search ID, field or coordinates"
              value={query}
              onChange={(e) => {
                setVisible(18);
                setQuery(e.target.value);
              }}
            />
            <select
              aria-label="Candidate classification"
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
            >
              <option value="">All interpretations</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {readable(s)}
                </option>
              ))}
            </select>
            <select
              aria-label="Survey field"
              value={fieldFilter}
              onChange={(e) => {
                setVisible(18);
                setFieldFilter(e.target.value);
              }}
            >
              <option value="">All fields</option>
              {snapshot.fields
                .filter((f) =>
                  snapshot.candidates.some((c) => c.fieldId === f.id),
                )
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
            </select>
            <select
              aria-label="Rank candidate peaks"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="gain">Rank by S/N gain</option>
              <option value="snr">Rank by nominal S/N</option>
              <option value="motion">Rank by trial speed</option>
              <option value="brightness">Rank by brightness proxy</option>
            </select>
            <label className="catalog-filter">
              <input
                type="checkbox"
                checked={checkedOnly}
                onChange={(e) => {
                  setVisible(18);
                  setCheckedOnly(e.target.checked);
                }}
              />{" "}
              Catalog checked
            </label>
          </>
        )}
      </div>
      {screen === "candidates" ? (
        <div>
          <p className="caption candidate-count">
            {matches.length} of {snapshot.candidates.length} retained trial
            peaks. These are signals to investigate.
          </p>
          <details className="finding-guide">
            <summary>What do the images and numbers mean?</summary>
            <p>
              Each grayscale image shows one real NASA exposure from the
              candidate’s search. We stretch the contrast to show faint
              details. Black pixels mark regions without usable data. The
              cyan ring marks where the tested motion would place the signal
              on that date. A few previews were processed again from the
              same FITS exposure. Their pixels can differ from the recorded
              search inputs.
            </p>
            <p>
              Nominal S/N estimates how clearly the signal stands out from
              noise. S/N gain is the change from a search that keeps the
              position fixed. Trial speed is how fast the search moved the
              test position across the sky. Open a candidate to compare epochs,
              check image quality and read the catalog results.
            </p>
          </details>
          <div className="candidate-gallery">
            {matches.slice(0, visible).map((c) => (
              <article key={c.id} className="finding-card">
                <div className="finding-card-top">
                  <span className="tag">
                    D{c.detector} · {readable(c.classification)}
                  </span>
                  <span>
                    {c.catalogInvestigation
                      ? "Catalog checked"
                      : "Review pending"}
                  </span>
                </div>
                <CandidatePreview
                  candidate={c}
                  previews={previews}
                  onDetails={() => show(c.id)}
                />
                <h3>
                  <button onClick={() => show(c.id)}>
                    {c.id}
                    <ArrowUpRight size={16} />
                  </button>
                </h3>
                <p>
                  {snapshot.fields.find((f) => f.id === c.fieldId)?.label ??
                    "Survey field"}{" "}
                  · {fmt(c.ra, 4)}°, {fmt(c.dec, 4)}°
                </p>
                <dl>
                  <div>
                    <dt>Nominal S/N</dt>
                    <dd>{fmt(c.evidence.nominalSnr, 1)}</dd>
                  </div>
                  <div>
                    <dt>S/N gain</dt>
                    <dd>{fmt(c.evidence.snrGainOverStatic, 1)}</dd>
                  </div>
                  <div>
                    <dt>Trial speed (″/day)</dt>
                    <dd>{fmt(speed(c), 3)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
          {!matches.length && (
            <p className="caption">
              {snapshot.candidates.length
                ? "No candidates match these filters."
                : "No peaks passed the recorded retention criteria."}
            </p>
          )}
          {matches.length > visible && (
            <button
              className="secondary finding-more"
              onClick={() => setVisible((n) => n + 18)}
            >
              Show more candidates <ArrowRight size={15} />
            </button>
          )}
        </div>
      ) : (
        <div className="survey-fields">
          {snapshot.fields.map((f) => (
            <details key={f.id}>
              <summary>
                <strong>{f.label}</strong>
                <span>
                  {fmt(f.ra, 4)}°, {fmt(f.dec, 4)}° · D{f.detector}
                </span>
                <span className="tag">{readable(f.status)}</span>
              </summary>
              <p>{f.latest?.message || "No processing attempt recorded."}</p>
              <p className="caption">
                {f.latest?.observationsFetched ?? 0} retrieved ·{" "}
                {f.latest?.observationsAnalyzed ?? 0} analyzed ·{" "}
                {fmt(f.latest?.baselineDays, 1)} days · metadata{" "}
                {readable(f.latest?.searchStatus)}
                {f.latest?.finishedAt ? ` · ${when(f.latest.finishedAt)}` : ""}
              </p>
              {f.latest?.notes?.map((n, i) => (
                <p className="caption" key={i}>
                  {n}
                </p>
              ))}
              {!!f.history?.length && (
                <details className="raw-result">
                  <summary>Attempt history</summary>
                  <pre>{JSON.stringify(f.history, null, 2)}</pre>
                </details>
              )}
            </details>
          ))}
        </div>
      )}
      <details className="raw-result">
        <summary>Survey settings and interpretation limits</summary>
        {snapshot.limitations.map((l, i) => (
          <p key={i} className="caption">
            {l}
          </p>
        ))}
        <pre>{JSON.stringify(snapshot.config, null, 2)}</pre>
      </details>
    </section>
  );
}

function CandidateTrack({ input }: { input: InvestigationInput }) {
  const samples = input.evidence.epochMeasurements ?? [];
  const decScale = Math.cos((input.dec * Math.PI) / 180);
  const offsets = samples.map((epoch) => ({
    x: (((epoch.ra - input.ra + 540) % 360) - 180) * 3600 * decScale,
    y: (epoch.dec - input.dec) * 3600,
    mjd: epoch.mjd,
  }));
  const extent = Math.max(
    1,
    ...offsets.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]),
  );
  const coordinates = offsets.map((p) => ({
    ...p,
    u: 120 + (p.x / extent) * 42,
    v: 51 - (p.y / extent) * 42,
  }));
  return (
    <svg
      className="finding-track"
      viewBox="0 0 240 102"
      role="img"
      aria-label="Modeled trial direction across exposure dates"
    >
      <path
        d="M18 51H224 M120 7V95"
        stroke="#587495"
        opacity=".48"
        strokeDasharray="3 5"
      />
      <path
        d="M64 12V90 M176 12V90 M20 23H220 M20 79H220"
        stroke="#293b58"
        opacity=".6"
      />
      <text x="8" y="15" fill="#a6bed8" fontSize="8">
        N
      </text>
      <text x="221" y="46" fill="#a6bed8" fontSize="8">
        E
      </text>
      <polyline
        points={coordinates.map((p) => `${p.u},${p.v}`).join(" ")}
        fill="none"
        stroke="#88dff4"
        strokeWidth="1.4"
      />
      {coordinates.map((p, i) => (
        <circle
          key={i}
          cx={p.u}
          cy={p.v}
          r={i === coordinates.length - 1 ? 4 : 2.7}
          stroke="#91defa"
          fill={i === coordinates.length - 1 ? "#9eeaff" : "#0c1e31"}
        >
          <title>
            {date(p.mjd)} · east {fmt(p.x, 2)}″ · north {fmt(p.y, 2)}″
          </title>
        </circle>
      ))}
      <text x="7" y="96" fill="#90accb" fontSize="8">
        ± {fmt(extent, 1)} arcsec
      </text>
    </svg>
  );
}

function Metric({
  value,
  label,
}: {
  value: number | string | undefined;
  label: string;
}) {
  return (
    <div>
      <strong>
        {typeof value === "number" ? value.toLocaleString() : (value ?? "—")}
      </strong>
      <span>{label}</span>
    </div>
  );
}

function CandidateDetail({
  input,
  candidate,
  onBack,
  onOpen,
}: {
  input: InvestigationInput;
  candidate?: Candidate;
  onBack: () => void;
  onOpen: (c: Candidate, v: View) => void;
}) {
  const id = input.id || "manual";
  const key = `slowtrace-candidate:${id}`;
  const [checks, setChecks] = useState<Investigation[]>(() =>
    stored(`${key}:checks`, []),
  );
  const [reviews, setReviews] = useState<Review[]>(() =>
    stored(`${key}:reviews`, []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState("");
  const [interpretation, setInterpretation] = useState("Needs review");
  const report =
    checks[0] ?? candidate?.catalogInvestigation ?? candidate?.investigation;
  const evidence = input.evidence;
  const epochs = evidence.epochMeasurements ?? [];
  function persist<T>(suffix: string, records: T[]) {
    try {
      localStorage.setItem(`${key}:${suffix}`, JSON.stringify(records));
    } catch {
      setError(
        "Browser storage is unavailable. Export the report to keep a copy.",
      );
    }
  }
  async function check() {
    setBusy(true);
    setError("");
    try {
      const next = await post<Investigation>("/api/investigate", input);
      const history = [next, ...checks].slice(0, 10);
      setChecks(history);
      persist("checks", history);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function addReview() {
    if (!review.trim()) return;
    const records = [
      { time: new Date().toISOString(), interpretation, note: review.trim() },
      ...reviews,
    ];
    setReviews(records);
    persist("reviews", records);
    setReview("");
  }
  return (
    <section className="panel tool-panel candidate-detail">
      <button className="text-button" onClick={onBack}>
        <ArrowLeft size={15} /> Survey records
      </button>
      <div className="panel-heading">
        <div>
          <span className="eyebrow">CANDIDATE INVESTIGATION</span>
          <h2>{candidate?.id ?? "DeepTrace peak"}</h2>
          <p className="caption">
            ICRS {fmt(input.ra, 6)}°, {fmt(input.dec, 6)}° · reference MJD{" "}
            {fmt(input.referenceMjd, 5)}
          </p>
        </div>
        <span className="tag">
          {readable(
            report?.classification ??
              candidate?.classification ??
              "insufficient evidence",
          )}
        </span>
      </div>
      <div className="recovery-grid">
        <Metric value={fmt(evidence.nominalSnr)} label="Nominal S/N" />
        <Metric value={fmt(evidence.staticSnr)} label="Stationary S/N" />
        <Metric value={fmt(evidence.snrGainOverStatic)} label="S/N gain" />
        <Metric
          value={`${fmt(evidence.velocityWestArcsecDay, 3)}, ${fmt(evidence.velocitySouthArcsecDay, 3)}`}
          label="Grid motion west/south (″/day)"
        />
      </div>
      <p className="caption">
        Motion is a trial trajectory. The search tests many velocities and
        resampling correlates image noise. The reported S/N is a ranking
        measurement, with no calibrated probability.
      </p>
      <div className="survey-controls">
        {candidate?.field && (
          <>
            {(
              [
                ["observe", "Open exact images"],
                ["atlas", "Locate in Sky Atlas"],
                ["solar", "View sightline in 3D"],
                ["trace", "Open DeepTrace"],
                ["spectra", "Open spectra"],
                ["notebook", "Review in notebook"],
                ["planner", "Plan follow-up"],
              ] as const
            ).map(([view, label]) => (
              <button
                className="secondary"
                key={view}
                onClick={() => onOpen(candidate, view)}
              >
                {view === "observe" ? (
                  <Telescope size={15} />
                ) : view === "atlas" ? (
                  <Globe2 size={15} />
                ) : view === "solar" ? (
                  <Orbit size={15} />
                ) : view === "notebook" ? (
                  <BookOpen size={15} />
                ) : null}
                {label}
              </button>
            ))}
          </>
        )}
        <button
          className="secondary"
          onClick={() =>
            download(`slowtrace-${id}-investigation.json`, {
              candidate: candidate ?? input,
              catalogHistory: checks,
              publishedInvestigation:
                candidate?.catalogInvestigation ?? candidate?.investigation,
              localReviewHistory: reviews,
            })
          }
        >
          <ArrowDownToLine size={15} /> Export investigation
        </button>
      </div>
      <h3>Observation evidence</h3>
      {epochs.length > 1 && (
        <div className="finding-track-detail">
          <CandidateTrack input={input} />
          <div>
            <h4>Modeled motion track</h4>
            <p className="caption">
              The line shows the path tested by the search. Each marker is a
              calculated position on the path at a real exposure time. East
              and north offsets share the same angular scale.
            </p>
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Epoch UTC</th>
              <th>RA / Dec</th>
              <th>Position basis</th>
              <th>Local µm</th>
              <th>Surface brightness (MJy/sr)</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {epochs.map((e, i) => (
              <tr key={i}>
                <td>{date(e.mjd)}</td>
                <td>
                  {fmt(e.ra, 6)}° / {fmt(e.dec, 6)}°
                </td>
                <td>{readable(e.positionKind || "modeled track")}</td>
                <td>{fmt(e.wavelengthUm, 3)}</td>
                <td>
                  {fmt(e.surfaceBrightnessMjySr, 4)}
                  {typeof e.variance === "number" && e.variance >= 0
                    ? ` ± ${fmt(Math.sqrt(e.variance), 4)}`
                    : ""}
                </td>
                <td>{e.flagBits ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!epochs.length && (
        <p className="caption">
          No per-epoch positions were retained. Catalog checks are limited to
          positional context.
        </p>
      )}
      {!!candidate?.observations.length && (
        <ul className="evidence-files">
          {candidate.observations.map((o) => (
            <li key={o.url}>
              <a href={o.url} target="_blank" rel="noreferrer">
                {o.id} · {date(o.date ?? o.mjd)} <ExternalLink size={12} />
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="section-title candidate-section">
        <h3>
          <ShieldCheck size={17} /> Catalog evidence and competing explanations
        </h3>
        <button
          className="primary"
          onClick={() => void check()}
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle className="spinner" size={15} />
          ) : (
            <Radar size={15} />
          )}{" "}
          {busy ? "Checking catalogs…" : "Check Gaia and NASA JPL"}
        </button>
      </div>
      {!!error && (
        <p className="load-status error" role="alert">
          {error}
        </p>
      )}
      {report ? (
        <>
          <p className="caption">
            {when(
              report.checkedAt ?? report.investigatedAt ?? report.generatedAt,
            )}{" "}
            · {readable(report.classification)}
          </p>
          {report.reasons?.map((r, i) => (
            <p key={i} className="candidate-reason">
              {r}
            </p>
          ))}
          <div className="catalog-columns">
            <Catalog name="Gaia DR3" value={report.gaia} />
            <Catalog name="NASA JPL" value={report.jpl} />
          </div>
          {Array.isArray(report.hypotheses) && (
            <ul className="candidate-hypotheses">
              {report.hypotheses.map(
                (item: { name: string; evidence: string }, index: number) => (
                  <li key={index}>
                    <strong>{item.name}</strong> — {item.evidence}
                  </li>
                ),
              )}
            </ul>
          )}
          {report.warnings?.map((w, i) => (
            <p className="caption" key={i}>
              {w}
            </p>
          ))}
          <details className="raw-result">
            <summary>Catalog hypotheses and original response</summary>
            <pre>{JSON.stringify(report, null, 2)}</pre>
          </details>
        </>
      ) : (
        <p className="caption">
          Check the candidate against Gaia sources and time-dependent small-body
          predictions. A missing or unavailable catalog match does not establish
          discovery.
        </p>
      )}
      <div className="candidate-section">
        <h3>Review history</h3>
        <p className="caption">
          Your review entries and on-demand checks are stored in this browser
          and included in the download. Published automated attempts remain part
          of the survey record.
        </p>
        <div className="survey-controls">
          <label>
            Interpretation{" "}
            <select
              value={interpretation}
              onChange={(e) => setInterpretation(e.target.value)}
            >
              {[
                "Needs review",
                "Possible known-object match",
                "Possible artifact",
                "Unidentified candidate",
                "Insufficient evidence",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="stacked-label">
          Review note
          <textarea
            rows={3}
            value={review}
            onChange={(e) => setReview(e.target.value)}
            placeholder="Which observation or catalog evidence supports this interpretation?"
          />
        </label>
        <button
          className="secondary"
          disabled={!review.trim()}
          onClick={addReview}
        >
          Record local review
        </button>
        {reviews.map((r, i) => (
          <article className="note" key={i}>
            <small>
              {when(r.time)} · {r.interpretation}
            </small>
            <p>{r.note}</p>
          </article>
        ))}
        {[...(candidate?.history ?? []), ...checks].length > 0 && (
          <details className="raw-result">
            <summary>Automated investigation history</summary>
            <pre>
              {JSON.stringify(
                { published: candidate?.history ?? [], catalogChecks: checks },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    </section>
  );
}

interface CatalogEntry {
  name?: string;
  sourceId?: string;
  rmsArcsec?: number;
  closestArcsec?: number;
  status?: string;
  withinTolerance?: number;
  observer?: string;
  mjd?: number;
  nearbyCount?: number;
  url?: string;
  error?: string;
}

function Catalog({
  name,
  value,
}: {
  name: string;
  value?: Record<string, unknown>;
}) {
  const isGaia = name === "Gaia DR3";
  const entries = (
    Array.isArray(value?.matches)
      ? value.matches
      : Array.isArray(value?.horizons)
        ? value.horizons
        : []
  ) as CatalogEntry[];
  const checks = (
    Array.isArray(value?.epochChecks) ? value.epochChecks : []
  ) as CatalogEntry[];
  const status = typeof value?.status === "string" ? value.status : undefined;
  return (
    <div className="catalog-summary">
      <h4>{name}</h4>
      <strong>
        {status === "ok" ? "Scoped check completed" : readable(status)}
      </strong>
      {entries.length ? (
        <ul>
          {entries.slice(0, 6).map((item, index) => (
            <li key={index}>
              <span>{item.name ?? item.sourceId ?? "Catalog entry"}</span>
              {typeof (item.rmsArcsec ?? item.closestArcsec) === "number" && (
                <>
                  {" "}
                  · {fmt(item.rmsArcsec ?? item.closestArcsec, 2)}″ separation
                  (RMS where available)
                </>
              )}
              {item.status && item.status !== "ok" && (
                <> · {readable(item.status)}</>
              )}
            </li>
          ))}
        </ul>
      ) : (
        status === "ok" && (
          <p className="caption">
            {isGaia
              ? "No Gaia source was returned within the stated tolerance."
              : "No shortlisted target reached Horizons refinement."}
          </p>
        )
      )}
      {checks.length > 0 && (
        <ul>
          {checks.map((entry, index) => (
            <li key={index}>
              {entry.mjd ? date(entry.mjd) : "Epoch"} ·{" "}
              {entry.observer ?? "observer unavailable"} ·{" "}
              {readable(entry.status)}
              {entry.nearbyCount !== undefined
                ? ` · ${entry.nearbyCount} nearby predictions`
                : ""}
            </li>
          ))}
        </ul>
      )}
      {typeof value?.message === "string" && (
        <p className="caption">{value.message}</p>
      )}
    </div>
  );
}
