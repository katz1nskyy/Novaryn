import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ChartNoAxesCombined,
  CircleAlert,
  Crosshair,
  FlaskConical,
  Globe2,
  Layers3,
  ScanLine,
  Timer,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Candidate } from "./surveyTypes";
import BulkSurveyView from "./statistics/BulkSurveyView";
import { initialCloudJobId } from "./cloudSurvey";
import {
  candidateSpeed,
  dateOfMjd,
  distribution,
  finite,
  nominalAreaCeiling,
  readable,
  sampledBrightness,
  surveyFields,
  utcDate,
  validSamples,
} from "./statistics/data";
import type {
  InjectionRecord,
  StatisticsSnapshot,
  SurveyInput,
} from "./statistics/data";
import "./statistics/statistics.css";

const TrackSpace = lazy(() => import("./statistics/TrackSpace"));
const RemoteSurvey = lazy(() => import("./RemoteSurvey"));
const number = new Intl.NumberFormat("en-CA");
const isCandidateInput = (record: Candidate | undefined): record is Candidate =>
  Boolean(record);
const label = (n: unknown, precision = 2) =>
  finite(n) ? n.toFixed(precision) : "—";
const colors = [
  "#79e5ff",
  "#b4a0ff",
  "#ffbd86",
  "#8de7b3",
  "#87aaff",
  "#f1a9d4",
];
const tick = { fill: "#9caec8", fontSize: 11 };
const chartGrid = "#233650";
const smallAxisLabel = (value: string) => ({
  value,
  position: "insideBottom" as const,
  offset: -15,
  fill: "#9caec8",
  fontSize: 11,
});

type TargetHandler = (ra: number, dec: number, name?: string) => void;
interface Props {
  onCandidate: (id: string) => void;
  onAtlas?: TargetHandler;
  onLab?: () => void;
}

const sections = [
  "Large archive survey",
  "Remote survey",
  "Survey fields",
  "Detections",
  "Validation",
] as const;
type Section = (typeof sections)[number];
type PilotSection = Exclude<Section, "Large archive survey" | "Remote survey">;

export default function Statistics(props: Props) {
  const [section, setSection] = useState<Section>(() =>
    initialCloudJobId() ? "Remote survey" : "Large archive survey",
  );
  return (
    <div className="statistics-center">
      <div className="stats-toolrow">
        <nav className="stats-tabs" aria-label="Statistics views">
          {sections.map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={section === name}
              onClick={() => setSection(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <span className="stats-scope">
          <span /> {section === "Remote survey" ? "Remote survey records" : "Published survey records"}
        </span>
      </div>
      {section === "Large archive survey" ? (
        <BulkSurveyView onAtlas={props.onAtlas} />
      ) : section === "Remote survey" ? (
        <Suspense fallback={<p className="stats-notice" role="status">Opening remote survey…</p>}>
          <RemoteSurvey />
        </Suspense>
      ) : (
        <PilotStatistics {...props} section={section} />
      )}
    </div>
  );
}

function PilotStatistics({
  onCandidate,
  onAtlas,
  onLab,
  section,
}: Props & { section: PilotSection }) {
  const [snapshot, setSnapshot] = useState<StatisticsSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [requestKey, setRequestKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/survey.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Survey unavailable");
        const value = (await response.json()) as StatisticsSnapshot;
        if (
          !Array.isArray(value.analyses) ||
          !Array.isArray(value.fields) ||
          !Array.isArray(value.candidates)
        )
          throw new Error("Incomplete survey snapshot");
        setSnapshot(value);
        setLoadError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [requestKey]);

  if (!snapshot)
    return (
      <div className="stats-notice" role="status">
        {loadError ? <CircleAlert size={18} /> : <Activity size={18} />}
        <span>
          {loadError
            ? "The published survey could not be loaded."
            : "Loading the published survey…"}
        </span>
        {loadError && (
          <button
            type="button"
            className="stats-button"
            onClick={() => {
              setLoadError(false);
              setRequestKey((key) => key + 1);
            }}
          >
            Try again
          </button>
        )}
      </div>
    );

  const summary = snapshot.summary;
  const formatted = (value: unknown) =>
    finite(value) ? number.format(value) : "—";
  return (
    <div className="statistics-center">
      <div className="stats-intro">
        <div>
          <span className="stats-kicker">
            <Activity size={15} /> Survey telemetry
          </span>
          <h2>{snapshot.label}</h2>
          <p>
            Trace the survey from calibrated SPHEREx images to motion trials and
            recorded validation.
          </p>
        </div>
        <div className="stats-intro-meta">
          <span>Published {utcDate(snapshot.generatedAt)} · UTC</span>
          <a
            className="stats-button"
            href="/survey.json"
            download="slowtrace-survey.json"
          >
            <ArrowDownToLine size={15} /> Download snapshot
          </a>
        </div>
      </div>

      <div className="stats-metrics" aria-label="Survey totals">
        <Metric
          icon={<Layers3 size={16} />}
          value={formatted(summary.uniqueExposuresAnalyzed)}
          name="Unique exposures"
          note="Distinct calibrated inputs"
        />
        <Metric
          icon={<Globe2 size={16} />}
          value={`${formatted(summary.fieldsAnalyzed)} / ${formatted(summary.planned)}`}
          name="Fields analyzed"
          note="Analyzed / planned"
        />
        <Metric
          icon={<ScanLine size={16} />}
          value={formatted(summary.usablePixelSamples)}
          name="Usable pixel samples"
          note="Across analysis inputs"
        />
        <Metric
          icon={<Crosshair size={16} />}
          value={formatted(summary.candidates)}
          name="Retained peaks"
          note="Candidates for investigation"
        />
      </div>

      {section === "Survey fields" && (
        <SurveyView snapshot={snapshot} onAtlas={onAtlas} />
      )}
      {section === "Detections" && (
        <DetectionView
          snapshot={snapshot}
          onCandidate={onCandidate}
          onAtlas={onAtlas}
        />
      )}
      {section === "Validation" && <ValidationView onLab={onLab} />}
    </div>
  );
}

function Metric({
  icon,
  name,
  value,
  note,
}: {
  icon: ReactNode;
  name: string;
  value: string;
  note: string;
}) {
  return (
    <div className="stats-metric">
      <div>
        {icon}
        <span>{name}</span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function PlotCard({
  title,
  description,
  children,
  footer,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`stats-panel ${className}`}>
      <div className="stats-panel-header">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {children}
      {footer && <div className="stats-panel-footer">{footer}</div>}
    </section>
  );
}

const statuses = [
  { key: "complete", name: "Complete", color: "#79e5ff" },
  { key: "empty", name: "No exposures", color: "#8de7b3" },
  { key: "incomplete", name: "Incomplete", color: "#b4a0ff" },
  { key: "error", name: "Failed", color: "#ffad9f" },
  { key: "running", name: "Running", color: "#87aaff" },
  { key: "queued", name: "Queued", color: "#74849a" },
];

function SurveyView({
  snapshot,
  onAtlas,
}: {
  snapshot: StatisticsSnapshot;
  onAtlas?: TargetHandler;
}) {
  const [detector, setDetector] = useState("all");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const fields = useMemo(() => surveyFields(snapshot), [snapshot]);
  const shown = fields.filter(
    (field) => detector === "all" || String(field.detector) === detector,
  );
  const analyzed = shown.filter((field) => field.analyzed);
  const areaCeiling = nominalAreaCeiling(analyzed);
  const skyPercent = (areaCeiling / ((180 / Math.PI) ** 2 * 4 * Math.PI)) * 100;
  const statusCounts = statuses.map((status) => ({
    ...status,
    count: shown.filter((field) => field.status === status.key).length,
  }));
  const tables = shown.filter((field) => field.observations.length > 0);
  const dates = [
    ...new Set(
      tables.flatMap((field) => field.observations.map((obs) => obs.mjd)),
    ),
  ].sort((a, b) => a - b);
  const selected =
    shown.find((field) => field.id === selectedId) ?? tables[0] ?? shown[0];
  const [observation, setObservation] = useState<SurveyInput | null>(null);
  const chronological =
    dates.length > 1 ? dates[dates.length - 1] - dates[0] : 0;
  const position = (mjd: number) =>
    chronological > 0 ? 2 + (96 * (mjd - dates[0])) / chronological : 50;
  const detectorOptions = [
    ...new Set(fields.map((field) => field.detector)),
  ].sort();

  return (
    <>
      <div className="stats-toolbar">
        <label>
          Scope{" "}
          <select
            value={detector}
            onChange={(event) => {
              setDetector(event.target.value);
              setObservation(null);
            }}
          >
            <option value="all">All archived detectors</option>
            {detectorOptions.map((value) => (
              <option key={value} value={value}>
                Detector {value}
              </option>
            ))}
          </select>
        </label>
        <span>{shown.length} recorded fields</span>
      </div>
      <div className="stats-layout">
        <PlotCard
          title="Exposure timeline"
          description="Capture dates of the images used in the analyses. Select a point to open the calibrated exposure."
          className="stats-wide"
        >
          {dates.length ? (
            <div className="stats-timeline">
              <div className="stats-time-axis">
                <span>Field / ICRS</span>
                <div>
                  <span>{dateOfMjd(dates[0])}</span>
                  <span>{dateOfMjd(dates[dates.length - 1])}</span>
                </div>
              </div>
              {tables.map((field) => (
                <div
                  className={`stats-time-row ${selected?.id === field.id ? "is-selected" : ""}`}
                  key={field.id}
                >
                  <button
                    type="button"
                    className="stats-field-name"
                    onClick={() => {
                      setSelectedId(field.id);
                      setObservation(null);
                    }}
                  >
                    {field.label} <span>D{field.detector}</span>
                  </button>
                  <div className="stats-time-line">
                    {field.observations.map((obs) => (
                      <button
                        type="button"
                        key={obs.url}
                        aria-label={`${field.label}, ${dateOfMjd(obs.mjd)}, detector ${obs.detector}`}
                        title={`${dateOfMjd(obs.mjd)} · ${obs.collection.toUpperCase().replace("SPHEREX_", "")} · ${label(obs.wavelengthUm, 3)} µm`}
                        className={`stats-time-mark ${observation?.url === obs.url && selected?.id === field.id ? "is-active" : ""}`}
                        style={{
                          left: `${position(obs.mjd)}%`,
                          color: colors[obs.detector - 1],
                        }}
                        onClick={() => {
                          setSelectedId(field.id);
                          setObservation(obs);
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div className="stats-legend">
                <span>
                  <i style={{ background: colors[0] }} /> Exposure used by
                  analysis
                </span>
                <span>Dates in UTC</span>
              </div>
            </div>
          ) : (
            <Empty text="No analyzed exposures are recorded for this selection." />
          )}
          <div className="stats-sample-detail">
            {selected && (
              <span>
                <strong>{selected.label}</strong> · {label(selected.ra, 4)}°,{" "}
                {label(selected.dec, 4)}° · {selected.observations.length}{" "}
                distinct input exposures
              </span>
            )}
            {observation && (
              <a href={observation.url} target="_blank" rel="noreferrer">
                Original FITS <ArrowRight size={14} />
              </a>
            )}
            {onAtlas && selected && (
              <button
                className="stats-button"
                type="button"
                onClick={() =>
                  onAtlas(selected.ra, selected.dec, selected.label)
                }
              >
                <Globe2 size={14} /> On the atlas
              </button>
            )}
          </div>
        </PlotCard>

        <PlotCard
          title="Field outcomes"
          description="Latest recorded status for each field in scope."
        >
          <div className="stats-status-bars" role="list">
            {statusCounts.map((status) => (
              <div
                role="listitem"
                className="stats-status-line"
                key={status.key}
              >
                <span>{status.name}</span>
                <div>
                  <i
                    style={{
                      width: `${shown.length ? (100 * status.count) / shown.length : 0}%`,
                      background: status.color,
                    }}
                  />
                </div>
                <strong>{status.count}</strong>
              </div>
            ))}
          </div>
          <div className="stats-area">
            <div>
              <span>Nominal area ceiling</span>
              <strong>≤ {label(areaCeiling, 3)} deg²</strong>
            </div>
            <p>
              ≤ {label(skyPercent, 6)}% of the celestial sphere. The sum uses
              the requested field footprints before overlap or masking. Actual
              unique valid area is unavailable.
            </p>
          </div>
        </PlotCard>
      </div>

      <PlotCard
        title="Survey ledger"
        description="Archive and processing provenance by field. An incomplete lookup can still have some analyzed exposures."
      >
        <div className="stats-table-scroll">
          <table className="stats-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Detector</th>
                <th>Outcome</th>
                <th>Images used</th>
                <th>Latest baseline</th>
                <th>Lead count</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((field) => (
                <tr key={field.id}>
                  <td>
                    {onAtlas ? (
                      <button
                        className="stats-inline"
                        type="button"
                        onClick={() =>
                          onAtlas(field.ra, field.dec, field.label)
                        }
                      >
                        {field.label}
                      </button>
                    ) : (
                      field.label
                    )}
                  </td>
                  <td>D{field.detector}</td>
                  <td className="stats-status-name">
                    {readable(field.status)}
                  </td>
                  <td>{field.latest?.observationsAnalyzed ?? "—"}</td>
                  <td>
                    {finite(field.latest?.baselineDays)
                      ? `${label(field.latest?.baselineDays, 1)} d`
                      : "—"}
                  </td>
                  <td>
                    {field.analyzed
                      ? snapshot.candidates.filter(
                          (candidate) => candidate.fieldId === field.id,
                        ).length
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PlotCard>
      <ProgressChart fields={shown} />
    </>
  );
}

function ProgressChart({
  fields,
}: {
  fields: ReturnType<typeof surveyFields>;
}) {
  const milestones = fields
    .flatMap((field) => {
      const first = (field.history ?? [])
        .flatMap((entry) => {
          if (
            typeof entry.analysisId !== "string" ||
            typeof entry.finishedAt !== "string"
          )
            return [];
          const epoch = Date.parse(entry.finishedAt);
          return Number.isFinite(epoch) ? [epoch] : [];
        })
        .sort((a, b) => a - b)[0];
      return finite(first) ? [{ label: field.label, epoch: first }] : [];
    })
    .sort((a, b) => a.epoch - b.epoch)
    .map((item, index) => ({ ...item, count: index + 1 }));
  const showTime = (epoch: number) =>
    new Date(epoch).toLocaleTimeString("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hourCycle: "h23",
    });
  return (
    <PlotCard
      title="Processing timeline"
      description="When the first analysis for each field finished. Processing time is distinct from observation time."
    >
      {milestones.length ? (
        <div
          className="stats-chart stats-chart-progress"
          aria-label="Cumulative fields analyzed by processing time"
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={milestones}
              margin={{ top: 15, right: 22, bottom: 28, left: 0 }}
            >
              <CartesianGrid stroke={chartGrid} strokeDasharray="3 6" />
              <XAxis
                dataKey="epoch"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tick={tick}
                tickFormatter={showTime}
                label={smallAxisLabel("Processing time (UTC)")}
              />
              <YAxis allowDecimals={false} tick={tick} width={30} />
              <Tooltip
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as
                    (typeof milestones)[number] | undefined;
                  return active && point ? (
                    <ChartTip
                      heading={point.label}
                      values={[
                        [
                          "Completed at",
                          `${utcDate(new Date(point.epoch).toISOString())} ${showTime(point.epoch)} UTC`,
                        ],
                        ["Fields analyzed", String(point.count)],
                      ]}
                    />
                  ) : null;
                }}
              />
              <Line
                dataKey="count"
                name="Fields analyzed"
                type="stepAfter"
                stroke="#83e9ff"
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 1, fill: "#83e9ff" }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty text="No completed analyses have a recorded processing time in this selection." />
      )}
    </PlotCard>
  );
}

const xMetrics = {
  speed: { name: "Trial speed", unit: "arcsec/day", get: candidateSpeed },
  east: {
    name: "Eastward trial motion",
    unit: "arcsec/day",
    get: (candidate: Candidate) =>
      finite(candidate.evidence.velocityWestArcsecDay)
        ? -candidate.evidence.velocityWestArcsecDay
        : undefined,
  },
  baseline: {
    name: "Observation baseline",
    unit: "days",
    get: (candidate: Candidate) => candidate.evidence.baselineDays,
  },
  brightness: {
    name: "Median sampled brightness",
    unit: "MJy/sr",
    get: sampledBrightness,
  },
  epoch: {
    name: "Reference time",
    unit: "MJD",
    get: (candidate: Candidate) => candidate.referenceMjd,
  },
};
const yMetrics = {
  snr: {
    name: "Nominal S/N",
    unit: "",
    get: (candidate: Candidate) => candidate.evidence.nominalSnr,
  },
  gain: {
    name: "S/N gain over static",
    unit: "",
    get: (candidate: Candidate) => candidate.evidence.snrGainOverStatic,
  },
  north: {
    name: "Northward trial motion",
    unit: "arcsec/day",
    get: (candidate: Candidate) =>
      finite(candidate.evidence.velocitySouthArcsecDay)
        ? -candidate.evidence.velocitySouthArcsecDay
        : undefined,
  },
};
const reviewLabels = {
  pending: "Awaiting catalog check",
  "catalog-consistent": "Catalog consistent",
  "artifact-suspect": "Suspected artifact",
  "insufficient-evidence": "Insufficient evidence",
  other: "Other published outcome",
};

function reviewOutcome(candidate: Candidate): keyof typeof reviewLabels {
  if (!candidate.catalogInvestigation) return "pending";
  const outcome = candidate.catalogInvestigation.classification;
  if (
    outcome === "catalog-consistent" ||
    outcome === "artifact-suspect" ||
    outcome === "insufficient-evidence"
  ) {
    return outcome;
  }
  return "other";
}

function DetectionView({
  snapshot,
  onCandidate,
  onAtlas,
}: {
  snapshot: StatisticsSnapshot;
  onCandidate: (id: string) => void;
  onAtlas?: TargetHandler;
}) {
  const [scope, setScope] = useState("all");
  const [filter, setFilter] = useState("all");
  const [xKey, setXKey] = useState<keyof typeof xMetrics>("speed");
  const [yKey, setYKey] = useState<keyof typeof yMetrics>("snr");
  const [selectedId, setSelectedId] = useState(
    snapshot.candidates[0]?.id ?? "",
  );
  const x = xMetrics[xKey];
  const y = yMetrics[yKey];
  const xPrecision =
    x.unit === "arcsec/day" ? 3 : xKey === "brightness" ? 2 : 0;
  const possibleFields = new Set(
    snapshot.candidates.map((candidate) => candidate.fieldId),
  );
  const scoped = snapshot.candidates.filter(
    (candidate) =>
      (scope === "all" || scope === candidate.fieldId) &&
      (filter === "all" ||
        Boolean(candidate.catalogInvestigation) === (filter === "checked")),
  );
  const rows = scoped.flatMap((candidate) => {
    const xValue = x.get(candidate);
    const yValue = y.get(candidate);
    return finite(xValue) && finite(yValue)
      ? [
          {
            x: xValue,
            y: yValue,
            id: candidate.id,
            detector: candidate.detector,
          },
        ]
      : [];
  });
  const selected =
    scoped.find((candidate) => candidate.id === selectedId) ?? scoped[0];
  const field =
    selected && snapshot.fields.find((item) => item.id === selected.fieldId);
  const checked = scoped.filter(
    (candidate) => candidate.catalogInvestigation,
  ).length;

  return (
    <>
      <div className="stats-toolbar">
        <label>
          Field{" "}
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="all">All candidate fields</option>
            {snapshot.fields
              .filter((item) => possibleFields.has(item.id))
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          Catalog review{" "}
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All candidates</option>
            <option value="checked">Published catalog checks</option>
            {Object.entries(reviewLabels).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span>
          {rows.length} peaks plotted · {checked} with catalog checks
        </span>
      </div>
      <div className="stats-layout">
        <PlotCard
          title="Motion and signal"
          description="Each mark is a retained DeepTrace peak. Select a point to inspect its evidence."
        >
          <div className="stats-chart-controls">
            <label>
              Horizontal axis{" "}
              <select
                value={xKey}
                onChange={(event) =>
                  setXKey(event.target.value as keyof typeof xMetrics)
                }
              >
                {Object.entries(xMetrics).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Vertical axis{" "}
              <select
                value={yKey}
                onChange={(event) =>
                  setYKey(event.target.value as keyof typeof yMetrics)
                }
              >
                {Object.entries(yMetrics).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {rows.length ? (
            <div
              className="stats-chart stats-chart-motion"
              aria-label={`${y.name} by ${x.name}, ${rows.length} retained candidates`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart
                  margin={{ top: 12, right: 22, bottom: 26, left: 4 }}
                >
                  <CartesianGrid stroke={chartGrid} strokeDasharray="3 6" />
                  <XAxis
                    dataKey="x"
                    type="number"
                    name={x.name}
                    tick={tick}
                    domain={["auto", "auto"]}
                    tickFormatter={(value) => label(value, xPrecision)}
                    label={smallAxisLabel(`${x.name} (${x.unit})`)}
                  />
                  <YAxis
                    dataKey="y"
                    type="number"
                    name={y.name}
                    tick={tick}
                    tickFormatter={(value) =>
                      y.unit
                        ? label(value, 3)
                        : number.format(Math.round(value))
                    }
                    width={66}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      const point = payload?.find((entry) => entry.payload?.id)
                        ?.payload as (typeof rows)[number] | undefined;
                      return active && point ? (
                        <ChartTip
                          heading={point.id}
                          values={[
                            [
                              x.name,
                              `${label(point.x, x.unit === "arcsec/day" ? 5 : 2)} ${x.unit}`,
                            ],
                            [
                              y.name,
                              `${label(point.y, y.unit ? 5 : 2)} ${y.unit}`.trim(),
                            ],
                          ]}
                        />
                      ) : null;
                    }}
                  />
                  <Scatter
                    data={rows}
                    onClick={(point) => {
                      if (typeof point.payload?.id === "string")
                        setSelectedId(point.payload.id);
                    }}
                    isAnimationActive={false}
                  >
                    {rows.map((point) => (
                      <Cell
                        key={point.id}
                        fill={colors[point.detector - 1] ?? colors[0]}
                        fillOpacity={point.id === selected?.id ? 1 : 0.45}
                        stroke={point.id === selected?.id ? "#ffffff" : "none"}
                        strokeWidth={1.5}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty text="No detections with these measurements match the filters." />
          )}
          <p className="stats-plot-note">
            Motion comes from the trial grid. S/N depends on the tested stack,
            pixel scale and masks.
          </p>
        </PlotCard>

        <PlotCard
          title="Candidate readout"
          description="Choose a record from the chart or list."
        >
          {isCandidateInput(selected) ? (
            <div className="stats-candidate">
              <label>
                Candidate{" "}
                <select
                  value={selected.id}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {scoped.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.id}
                    </option>
                  ))}
                </select>
              </label>
              <span className="stats-candidate-state">
                {readable(selected.classification)}
              </span>
              <h4>{field?.label ?? "Survey field"}</h4>
              <span className="stats-mono">
                {label(selected.ra, 5)}° RA · {label(selected.dec, 5)}° Dec
              </span>
              <dl>
                <div>
                  <dt>Nominal S/N</dt>
                  <dd>{label(selected.evidence.nominalSnr, 1)}</dd>
                </div>
                <div>
                  <dt>Gain over static</dt>
                  <dd>{label(selected.evidence.snrGainOverStatic, 1)}</dd>
                </div>
                <div>
                  <dt>Trial speed</dt>
                  <dd>{label(candidateSpeed(selected), 5)} ″/d</dd>
                </div>
                <div>
                  <dt>Reference epoch</dt>
                  <dd>{dateOfMjd(selected.referenceMjd)}</dd>
                </div>
                <div>
                  <dt>Catalog review</dt>
                  <dd>
                    {selected.catalogInvestigation ? "Published" : "Pending"}
                  </dd>
                </div>
              </dl>
              <div className="stats-actions">
                <button
                  className="stats-button stats-button-primary"
                  type="button"
                  onClick={() => onCandidate(selected.id)}
                >
                  Open evidence <ArrowRight size={15} />
                </button>
                {onAtlas && (
                  <button
                    className="stats-button"
                    type="button"
                    onClick={() =>
                      onAtlas(selected.ra, selected.dec, selected.id)
                    }
                  >
                    <Globe2 size={14} /> Locate
                  </button>
                )}
              </div>
            </div>
          ) : (
            <Empty text="No candidates match the selected scope." />
          )}
        </PlotCard>
      </div>
      {selected && (
        <div className="stats-two">
          <PlotCard
            title="Trial track in three dimensions"
            description="East and north offsets from the candidate reference position, with observation time on the third axis."
          >
            <Suspense fallback={<Empty text="Preparing the track viewer…" />}>
              <TrackSpace candidate={selected} />
            </Suspense>
          </PlotCard>
          <SpectrumSamples candidate={selected} />
        </div>
      )}
      <div className="stats-two">
        <DetectionDistribution candidates={scoped} />
        <PlotCard
          title="Catalog review outcomes"
          description="Choose an outcome to filter the research plots. Catalog consistency is preliminary."
        >
          <div className="stats-review-options">
            {Object.entries(reviewLabels).map(([key, name]) => {
              const count = snapshot.candidates.filter(
                (candidate) =>
                  (scope === "all" || scope === candidate.fieldId) &&
                  reviewOutcome(candidate) === key,
              ).length;
              return (
                <button
                  className="stats-button"
                  disabled={!count && filter !== key}
                  type="button"
                  key={key}
                  aria-pressed={filter === key}
                  onClick={() => setFilter(filter === key ? "all" : key)}
                >
                  <span>{name}</span>
                  <strong>{number.format(count)}</strong>
                </button>
              );
            })}
          </div>
        </PlotCard>
      </div>
    </>
  );
}

const distributionMetrics = {
  speed: xMetrics.speed,
  snr: yMetrics.snr,
  brightness: xMetrics.brightness,
};

function DetectionDistribution({ candidates }: { candidates: Candidate[] }) {
  const [metric, setMetric] =
    useState<keyof typeof distributionMetrics>("speed");
  const { name, unit, get } = distributionMetrics[metric];
  const precision = metric === "speed" ? 5 : 2;
  const bins = distribution(candidates.map(get)).map((item) => ({
    first: label(item.from, precision),
    last: label(item.to, precision),
    ...item,
  }));
  const title = unit ? `${name} (${unit})` : name;

  return (
    <PlotCard
      title="Detection distribution"
      description="Each bar counts retained peaks in an equal-width measurement interval."
    >
      <div className="stats-chart-controls">
        <label>
          Measurement{" "}
          <select
            value={metric}
            onChange={(event) =>
              setMetric(event.target.value as keyof typeof distributionMetrics)
            }
          >
            {Object.entries(distributionMetrics).map(([key, value]) => (
              <option key={key} value={key}>
                {value.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {bins.length ? (
        <div className="stats-chart" aria-label={`${title} histogram`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={bins}
              margin={{ top: 6, right: 12, bottom: 26, left: 4 }}
            >
              <CartesianGrid
                stroke={chartGrid}
                strokeDasharray="3 6"
                vertical={false}
              />
              <XAxis
                dataKey="from"
                tick={tick}
                tickFormatter={(value) => label(value, precision)}
                label={smallAxisLabel(title)}
              />
              <YAxis allowDecimals={false} tick={tick} width={30} />
              <Tooltip
                cursor={{ fill: "#21344b" }}
                content={({ active, payload }) => {
                  const bin = payload?.[0]?.payload as
                    (typeof bins)[number] | undefined;
                  return active && bin ? (
                    <ChartTip
                      heading={title}
                      values={[
                        [
                          "Interval",
                          bin.from === bin.to
                            ? bin.first
                            : `${bin.first} to ${bin.last}`,
                        ],
                        ["Retained peaks", number.format(bin.count)],
                      ]}
                    />
                  ) : null;
                }}
              />
              <Bar
                dataKey="count"
                fill="#72dcf4"
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty text="This measurement is unavailable for the selected survey scope." />
      )}
    </PlotCard>
  );
}

function SpectrumSamples({ candidate }: { candidate: Candidate }) {
  const [axis, setAxis] = useState("wavelength");
  const saved = validSamples(candidate);
  const data = saved.flatMap((measurement) => {
    const x =
      axis === "wavelength" ? measurement.wavelengthUm : measurement.mjd;
    return finite(x) && finite(measurement.surfaceBrightnessMjySr)
      ? [
          {
            x,
            y: measurement.surfaceBrightnessMjySr,
            mjd: measurement.mjd,
            uncertainty:
              finite(measurement.variance) && measurement.variance >= 0
                ? Math.sqrt(measurement.variance)
                : null,
          },
        ]
      : [];
  });
  return (
    <PlotCard
      title="Samples along the trial track"
      description="Valid resampled pixels at the predicted track positions. Error bars use the archived per-pixel variance."
    >
      <div className="stats-chart-controls">
        <label>
          Sample axis{" "}
          <select
            value={axis}
            onChange={(event) => setAxis(event.target.value)}
          >
            <option value="wavelength">Wavelength · µm</option>
            <option value="time">Observation time · MJD</option>
          </select>
        </label>
      </div>
      {data.length ? (
        <div
          className="stats-chart"
          aria-label={`Candidate surface brightness by ${axis}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 12, right: 18, bottom: 28, left: 0 }}>
              <CartesianGrid stroke={chartGrid} strokeDasharray="3 6" />
              <XAxis
                dataKey="x"
                type="number"
                domain={["auto", "auto"]}
                name={axis === "wavelength" ? "Wavelength (µm)" : "MJD"}
                tick={tick}
                tickFormatter={(value) =>
                  label(value, axis === "wavelength" ? 3 : 0)
                }
                label={smallAxisLabel(
                  axis === "wavelength"
                    ? "Approximate wavelength (µm)"
                    : "Observation epoch (MJD)",
                )}
              />
              <YAxis
                dataKey="y"
                type="number"
                name="Surface brightness"
                width={62}
                tick={tick}
                unit=" MJy/sr"
              />
              <Tooltip
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as
                    (typeof data)[number] | undefined;
                  return active && point ? (
                    <ChartTip
                      heading={dateOfMjd(point.mjd)}
                      values={[
                        [
                          axis === "wavelength" ? "Wavelength" : "MJD",
                          label(point.x, 4),
                        ],
                        ["Surface brightness", `${label(point.y)} MJy/sr`],
                        [
                          "Pixel uncertainty",
                          finite(point.uncertainty)
                            ? `±${label(point.uncertainty, 3)} MJy/sr`
                            : "Unavailable",
                        ],
                      ]}
                    />
                  ) : null;
                }}
              />
              <Scatter data={data} fill={colors[0]} isAnimationActive={false}>
                <ErrorBar
                  dataKey="uncertainty"
                  direction="y"
                  stroke={colors[1]}
                  width={5}
                />
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty text="There are no usable track samples for this measurement axis." />
      )}
      <p className="stats-plot-note">
        Pixel samples across different frames do not establish a calibrated
        point-source spectrum.
      </p>
    </PlotCard>
  );
}

function ValidationView({ onLab }: { onLab?: () => void }) {
  const [record, setRecord] = useState<InjectionRecord | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/stats/injection-validation.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Validation record unavailable");
        setRecord((await response.json()) as InjectionRecord);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, []);
  if (!record)
    return (
      <Empty
        text={
          loadError
            ? "The validation record could not be loaded."
            : "Loading the archived experiment…"
        }
      />
    );
  const recovery = [
    {
      name: "Shift and stack",
      recovered: record.recovered.shiftStack,
      color: colors[0],
    },
    {
      name: "Static stack",
      recovered: record.recovered.staticStack,
      color: colors[1],
    },
    {
      name: "Single exposure",
      recovered: record.recovered.bestSingleFrame,
      color: colors[2],
    },
  ];
  const trials = record.measurements.map((item, index) => ({
    ...item,
    trial: index + 1,
  }));

  return (
    <>
      <div className="stats-validation-banner">
        <FlaskConical size={19} />
        <div>
          <strong>Recorded injection experiment</strong>
          <p>
            Synthetic sources were injected into{" "}
            {record.selectedFrameIndices.length} real SPHEREx exposures. These
            outcomes apply to this experiment.
          </p>
        </div>
        {onLab && (
          <button className="stats-button" type="button" onClick={onLab}>
            Open the lab <ArrowRight size={14} />
          </button>
        )}
      </div>
      <div className="stats-two">
        <PlotCard
          title="Recovery by method"
          description={`${record.trials} injected sources · ${label(record.thresholdSnr, 1)} nominal S/N threshold · ${label(record.baselineDays, 1)} day baseline`}
        >
          <div
            className="stats-chart"
            aria-label="Recovered synthetic injections by method"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={recovery}
                layout="vertical"
                margin={{ top: 12, left: 4, right: 22 }}
              >
                <CartesianGrid
                  stroke={chartGrid}
                  strokeDasharray="3 6"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  domain={[0, record.trials]}
                  tick={tick}
                />
                <YAxis type="category" dataKey="name" tick={tick} width={105} />
                <Tooltip
                  cursor={false}
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <ChartTip
                        heading={String(payload[0].payload.name)}
                        values={[
                          [
                            "Recovered",
                            `${payload[0].value} / ${record.trials}`,
                          ],
                        ]}
                      />
                    ) : null
                  }
                />
                <Bar
                  dataKey="recovered"
                  maxBarSize={18}
                  radius={[0, 3, 3, 0]}
                  isAnimationActive={false}
                >
                  {recovery.map((method) => (
                    <Cell key={method.name} fill={method.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </PlotCard>
        <PlotCard
          title="Signal for each injection"
          description="Vertical separation shows the difference between methods for the same trial."
        >
          <div
            className="stats-chart"
            aria-label="Nominal signal to noise by injection trial"
          >
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart
                margin={{ top: 12, right: 18, bottom: 25, left: 0 }}
              >
                <CartesianGrid stroke={chartGrid} strokeDasharray="3 6" />
                <XAxis
                  dataKey="trial"
                  type="number"
                  domain={[1, record.trials]}
                  tick={tick}
                  allowDecimals={false}
                  name="Trial"
                  label={smallAxisLabel("Injection trial")}
                />
                <YAxis
                  dataKey="value"
                  name="Nominal S/N"
                  width={38}
                  tick={tick}
                />
                <ReferenceLine
                  y={record.thresholdSnr}
                  stroke="#c2c8e0"
                  strokeDasharray="5 5"
                />
                <Tooltip
                  content={({ active, payload }) => {
                    const point = payload?.[0]?.payload as
                      | { trial: number; value: number; method: string }
                      | undefined;
                    return active && point ? (
                      <ChartTip
                        heading={`Trial ${point.trial}`}
                        values={[[point.method, label(point.value)]]}
                      />
                    ) : null;
                  }}
                />
                {(
                  [
                    "shiftStackSnr",
                    "staticStackSnr",
                    "bestSingleFrameSnr",
                  ] as const
                ).map((key, index) => (
                  <Scatter
                    key={key}
                    name={recovery[index].name}
                    data={trials.flatMap((trial) =>
                      finite(trial[key])
                        ? [
                            {
                              trial: trial.trial,
                              value: trial[key],
                              method: recovery[index].name,
                            },
                          ]
                        : [],
                    )}
                    fill={recovery[index].color}
                    isAnimationActive={false}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div className="stats-legend stats-method-legend">
            {recovery.map((method) => (
              <span key={method.name}>
                <i style={{ background: method.color }} /> {method.name}
              </span>
            ))}
          </div>
        </PlotCard>
      </div>
      <PlotCard
        title="Controls and limits"
        description="These controls measure peak counts for this single field and configuration."
      >
        <div className="stats-controls-list">
          <Metric
            icon={<Timer size={15} />}
            name="No injection"
            value={`${record.unInjectedControlPeaks}${record.unInjectedControlPeaks === record.controlPeakCountCappedAt ? "+" : ""}`}
            note="Motion-trial peaks"
          />
          <Metric
            icon={<ChartNoAxesCombined size={15} />}
            name="Sign-inverted input"
            value={`${record.negativeControlPeaks}${record.negativeControlPeaks === record.controlPeakCountCappedAt ? "+" : ""}`}
            note="Motion-trial peaks"
          />
          <Metric
            icon={<Crosshair size={15} />}
            name="Simulated trial speed"
            value={`${label(Math.hypot(...record.motionArcsecDay), 3)}″/d`}
            note="Single test condition"
          />
        </div>
        <p className="stats-plot-note">
          Counts are capped at {record.controlPeakCountCappedAt}. The pilot does
          not provide a calibrated false-alarm rate, a magnitude limit, or a
          sensitivity surface over speed and brightness.
        </p>
        <details className="stats-provenance">
          <summary>Experiment assumptions and caveats</summary>
          <ul>
            {record.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
        <a
          className="stats-button"
          href="/stats/injection-validation.json"
          download
        >
          <ArrowDownToLine size={15} /> Download experiment record
        </a>
      </PlotCard>
    </>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="stats-chart-empty" role="status">
      {text}
    </div>
  );
}

function ChartTip({
  heading,
  values,
}: {
  heading: string;
  values: [string, string][];
}) {
  return (
    <div className="stats-chart-tip">
      <strong>{heading}</strong>
      {values.map(([name, value]) => (
        <div key={name}>
          <span>{name}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}
