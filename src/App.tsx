import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ChartNoAxesCombined,
  Orbit,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Compass,
  Crosshair,
  ExternalLink,
  FlaskConical,
  Globe2,
  Layers3,
  LoaderCircle,
  Menu,
  NotebookPen,
  Pause,
  Play,
  ScanLine,
  Search,
  ShieldCheck,
  Radar,
  SlidersHorizontal,
  Sparkles,
  Telescope,
  Waves,
  X,
} from "lucide-react";
import { Tooltip } from "@base-ui/react/tooltip";
import { toast } from "sonner";
import SkyCanvas from "./SkyCanvas";
import EvidenceMaps from "./EvidenceMaps";
import AladinPanel from "./AladinPanel";
import TutorialButton from "./TutorialButton";
const SpectrumChart = lazy(() =>
  import("./Charts").then((m) => ({ default: m.SpectrumChart })),
);
const PlannerChart = lazy(() =>
  import("./Charts").then((m) => ({ default: m.PlannerChart })),
);
import MissionHome from "./MissionHome";
const Atlas = lazy(() => import("./Atlas"));
const Statistics = lazy(() => import("./Statistics"));
const SolarSystem = lazy(() => import("./SolarSystem"));
const BeginnerTour = lazy(() => import("./BeginnerTour"));
const AutomaticDetection = lazy(() => import("./AutomaticDetection"));
import ArchiveStatus from "./ArchiveStatus";
import {
  archiveFitsUrls,
  compareFrames,
  EXAMPLE_PATHS,
  parseCoordinate,
} from "./observation";
import type {
  Candidate,
  InvestigationInput,
  SurveySnapshot,
} from "./surveyTypes";
const SurveyDesk = lazy(() => import("./SurveyDesk"));
import {
  aperture,
  date,
  download,
  fmt,
  pixelSky,
  skyPixel,
  post,
  quantile,
  request,
} from "./lib";
import { DETECTORS, TARGETS } from "./types";
import type { Frame, Observation, Query, SearchResult } from "./types";

type Page =
  | "home"
  | "stats"
  | "solar"
  | "survey"
  | "observe"
  | "atlas"
  | "trace"
  | "spectra"
  | "lab"
  | "notebook"
  | "planner"
  | "methods";
type Note = {
  id: string;
  created: string;
  ra: number;
  dec: number;
  text: string;
  classification: string;
  sourceIds: string[];
  candidateId?: string;
};
type Result = Record<string, any>;
const TOOLS = [
  { id: "observe", label: "Observation desk", icon: Telescope },
  { id: "trace", label: "DeepTrace search", icon: ScanLine },
  { id: "spectra", label: "Spectral explorer", icon: Waves },
  { id: "lab", label: "Experiment lab", icon: FlaskConical },
  { id: "notebook", label: "Research notebook", icon: NotebookPen },
  { id: "planner", label: "Follow-up planner", icon: Compass },
] as const;
const NAV = [
  { id: "home", label: "Mission" },
  { id: "observe", label: "Observe" },
  { id: "atlas", label: "Sky Atlas" },
  { id: "spectra", label: "Spectra" },
  { id: "survey", label: "Discoveries" },
] as const;
const MISSION_NAV = [
  { id: "home", label: "Mission" },
  { id: "atlas", label: "Sky Atlas" },
  { id: "survey", label: "Discoveries" },
  { id: "stats", label: "Statistics" },
  { id: "solar", label: "Solar System" },
] as const;
const MORE = [
  { id: "trace", label: "DeepTrace" },
  { id: "lab", label: "Experiment lab" },
  { id: "notebook", label: "Notebook" },
  { id: "planner", label: "Planner" },
  { id: "stats", label: "Statistics" },
  { id: "solar", label: "Solar System" },
  { id: "methods", label: "Methods" },
] as const;
const TITLES: Record<Page, [string, string]> = {
  home: ["SLOWTRACE X", "SPHEREx multi-epoch viewer."],
  stats: ["Survey statistics", "Measured results from the published survey."],
  solar: ["Solar System", "JPL ephemerides along a sightline."],
  observe: ["Observe", "Blink SPHEREx epochs at a sky position."],
  survey: ["Discoveries", "Processed fields, measured peaks, catalog checks."],
  atlas: ["Sky Atlas", "Browse coordinates and open a field."],
  trace: ["DeepTrace", "Shift-and-stack motion search on the loaded epochs."],
  spectra: ["Spectra", "Aperture measurements across the loaded channels."],
  lab: ["Experiment lab", "Injection and recovery on real backgrounds."],
  notebook: ["Notebook", "Local notes and classifications."],
  planner: ["Planner", "Visibility for the selected position and site."],
  methods: ["Methods", "Sources, calculations, and limits."],
};
type LoadSource =
  | { kind: "recorded"; path: string }
  | { kind: "fits"; urls: string[]; label: string; pixels?: number };
type Packet = { search: SearchResult; frames: Frame[] };
const TUTORIAL_CUE_KEY = "slowtrace-tutorial-cue-seen";

function fieldKey(params: URLSearchParams) {
  return JSON.stringify(
    ["ra", "dec", "fov", "detector", "example", "evidence"].map((key) =>
      params.get(key),
    ),
  );
}

function initialPage(): Page {
  const params = new URLSearchParams(location.search);
  const page = params.get("page");
  if (page && Object.prototype.hasOwnProperty.call(TITLES, page))
    return page as Page;
  if (["ra", "dec", "evidence", "example"].some((key) => params.has(key)))
    return "observe";
  return "home";
}
type SpatialFocus = { ra: number; dec: number; label?: string; id?: string };
function initialFocus(): SpatialFocus | undefined {
  const params = new URLSearchParams(location.search);
  const ra = params.get("focusRa"),
    dec = params.get("focusDec");
  if (ra === null || dec === null) return;
  const x = Number(ra),
    y = Number(dec);
  if (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    x < 360 &&
    Math.abs(y) <= 90
  )
    return {
      ra: x,
      dec: y,
      label: params.get("focusLabel") || undefined,
      id: params.get("focusId") || undefined,
    };
}
function initialQuery(): Query {
  const p = new URLSearchParams(location.search);
  const ra = Number(p.get("ra") ?? TARGETS[0].ra),
    dec = Number(p.get("dec") ?? TARGETS[0].dec),
    fov = Number(p.get("fov") ?? 5),
    detector = Number(p.get("detector") ?? 1);
  return {
    ra: Number.isFinite(ra) && ra >= 0 && ra < 360 ? ra : TARGETS[0].ra,
    dec: Number.isFinite(dec) && Math.abs(dec) <= 90 ? dec : TARGETS[0].dec,
    fov: Number.isFinite(fov) && fov >= 2 && fov <= 30 ? fov : 5,
    detector:
      Number.isInteger(detector) && detector >= 0 && detector <= 6
        ? detector
        : 1,
  };
}
function Hint({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            className="icon-button"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8}>
          <Tooltip.Popup className="tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className={`notice ${tone}`}>
      <CircleHelp size={16} />
      <div>{children}</div>
    </div>
  );
}

function MissionHeader({
  mobile,
  toggleMenu,
  go,
}: {
  mobile: boolean;
  toggleMenu: () => void;
  go: (page: Page) => void;
}) {
  return (
    <header className="mission-header">
      <button
        className="mission-brand"
        onClick={() => go("home")}
        aria-label="SLOWTRACE X home"
      >
        <img src="/mark.svg" alt="" />
        <span>
          SLOWTRACE <b>X</b>
          <small>SPHEREx RESEARCH</small>
        </span>
      </button>
      <button
        className="mission-menu icon-button"
        aria-expanded={mobile}
        aria-controls="mission-navigation"
        aria-label={mobile ? "Close navigation" : "Open navigation"}
        onClick={toggleMenu}
      >
        {mobile ? <X size={21} /> : <Menu size={21} />}
      </button>
      <nav
        id="mission-navigation"
        aria-label="Main navigation"
        className={`mission-nav ${mobile ? "open" : ""}`}
      >
        {MISSION_NAV.map(({ id, label }) => (
          <button
            key={id}
            className={id === "home" ? "active" : ""}
            aria-current={id === "home" ? "page" : undefined}
            onClick={() => go(id)}
          >
            {label}
          </button>
        ))}
        <button className="mobile-desk" onClick={() => go("observe")}>
          Observation desk
        </button>
        <button className="mobile-desk" onClick={() => go("methods")}>
          Methods and provenance
        </button>
      </nav>
      <div className="header-actions">
        <button
          className="icon-button"
          aria-label="Methods and provenance"
          title="Methods and provenance"
          onClick={() => go("methods")}
        >
          <BookOpen size={18} />
        </button>
        <button className="secondary header-desk" onClick={() => go("observe")}>
          <Telescope size={16} /> Observation desk
        </button>
      </div>
    </header>
  );
}

export default function App() {
  const [tutorialOpen, setTutorialOpen] = useState(
    () => new URLSearchParams(location.search).get("tutorial") === "1",
  );
  const [firstVisit, setFirstVisit] = useState(() => {
    try {
      return !localStorage.getItem(TUTORIAL_CUE_KEY);
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (!firstVisit) return;
    try {
      localStorage.setItem(TUTORIAL_CUE_KEY, "1");
    } catch {
      // The tutorial still works when storage is unavailable.
    }
  }, [firstVisit]);
  const [page, setPage] = useState<Page>(initialPage),
    [spatialFocus, setSpatialFocus] = useState(initialFocus),
    [mobile, setMobile] = useState(false),
    [query, setQuery] = useState<Query>(initialQuery),
    [draft, setDraft] = useState<Query>(initialQuery),
    [raText, setRaText] = useState(() => String(initialQuery().ra)),
    [decText, setDecText] = useState(() => String(initialQuery().dec)),
    [inputError, setInputError] = useState(""),
    [fitsText, setFitsText] = useState(""),
    [referenceUrl, setReferenceUrl] = useState(""),
    [matchedOnly, setMatchedOnly] = useState(false),
    [candidateContext, setCandidateContext] = useState<Candidate | null>(null),
    [manualCandidate, setManualCandidate] = useState<InvestigationInput | null>(
      null,
    ),
    [search, setSearch] = useState<SearchResult | null>(null),
    [frames, setFrames] = useState<Frame[]>([]),
    [loading, setLoading] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [failures, setFailures] = useState<string[]>([]),
    [activeUrl, setActiveUrl] = useState(""),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(900),
    [mode, setMode] = useState("blink"),
    [qualityLayer, setQualityLayer] = useState(false),
    [showTrack, setShowTrack] = useState(true),
    [blend, setBlend] = useState(0.45),
    [contrast, setContrast] = useState(1),
    [palette, setPalette] = useState("ice"),
    [point, setPoint] = useState<{ x: number; y: number } | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [experiment, setExperiment] = useState<Result | null>(null),
    [working, setWorking] = useState(""),
    [maxSpeed, setMaxSpeed] = useState(0.15),
    [seed, setSeed] = useState(42),
    [injectionSnr, setInjectionSnr] = useState(3),
    [threshold, setThreshold] = useState(5),
    [note, setNote] = useState(""),
    [classification, setClassification] = useState("Needs investigation"),
    [notes, setNotes] = useState<Note[]>(() => {
      try {
        return JSON.parse(localStorage.getItem("slowtrace-notes") || "[]");
      } catch {
        return [];
      }
    }),
    [plan, setPlan] = useState<Result | null>(null),
    [lat, setLat] = useState(43.6532),
    [lon, setLon] = useState(-79.3832),
    [planDate, setPlanDate] = useState(new Date().toISOString().slice(0, 10)),
    [spectralAxis, setSpectralAxis] = useState("wavelength");
  const serial = useRef(0),
    controller = useRef<AbortController | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !(event.target as Element).closest?.(".navbar-more")
      )
        setMoreOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [moreOpen]);
  const reference =
    frames.find((f) => f.provenance.sourceUrl === referenceUrl) ?? frames[0];
  const timeline = useMemo(
    () =>
      matchedOnly && reference
        ? frames.filter(
            (f) => f === reference || compareFrames(f, reference).eligible,
          )
        : frames,
    [frames, reference, matchedOnly],
  );
  const active = Math.max(
    0,
    timeline.findIndex((f) => f.provenance.sourceUrl === activeUrl),
  );
  const frame = timeline[active];
  const comparison = compareFrames(frame, reference);
  const selectEpoch = (index: number) => {
    setActiveUrl(timeline[index]?.provenance.sourceUrl || "");
    setPlaying(false);
  };
  const commonStretch = useMemo<[number, number] | undefined>(() => {
    if (!frames.length) return;
    const values = frames.flatMap((f) =>
      f.data.filter((v): v is number => v !== null && Number.isFinite(v)),
    );
    return [quantile(values, 0.02), quantile(values, 0.995)];
  }, [frames]);
  const selected =
    point && frame
      ? pixelSky(point.x, point.y, frame.width, frame.height, query)
      : candidateContext
        ? { ra: candidateContext.ra, dec: candidateContext.dec }
        : { ra: query.ra, dec: query.dec };
  const target = TARGETS.find(
    (t) =>
      Math.abs(t.ra - query.ra) < 0.001 && Math.abs(t.dec - query.dec) < 0.001,
  );
  const fieldName = target?.name || "Custom sky field";
  const loadedFieldKey = useRef("");
  const load = useCallback(
    async (q: Query, source?: LoadSource, candidate?: Candidate) => {
      controller.current?.abort();
      const cancellation = new AbortController();
      controller.current = cancellation;
      const job = ++serial.current;
      const signal = cancellation.signal;
      setLoading(true);
      setError("");
      setInputError("");
      setFailures([]);
      setFrames([]);
      setSearch(null);
      setActiveUrl("");
      setReferenceUrl("");
      setMatchedOnly(false);
      setPoint(null);
      setCandidateContext(candidate ?? null);
      setResult(null);
      setExperiment(null);
      setPlan(null);
      setPlaying(false);
      setQuery(q);
      setDraft(q);
      setRaText(String(q.ra));
      setDecText(String(q.dec));
      setProgress(
        source?.kind === "recorded"
          ? "Loading recorded NASA observations…"
          : source?.kind === "fits"
            ? "Retrieving specified NASA images…"
            : "Searching DR1 and QR3 at NASA/IPAC IRSA…",
      );
      const params = new URLSearchParams(
        Object.entries(q).map(([key, value]) => [key, String(value)]),
      );
      if (source?.kind === "recorded") {
        const example = EXAMPLE_PATHS.indexOf(source.path);
        if (example >= 0) params.set("example", String(example));
      }
      if (candidate) params.set("evidence", candidate.id);
      const key = fieldKey(params);
      loadedFieldKey.current = key;
      const locationParams = new URLSearchParams(params);
      locationParams.set("page", initialPage());
      history.replaceState(null, "", `?${locationParams}`);
      try {
        if (source?.kind === "recorded") {
          const packet = await request<Packet>(source.path, { signal });
          if (signal.aborted || job !== serial.current) return;
          if (!packet.frames.length)
            throw new Error(
              "The recorded example contains no usable exposures.",
            );
          const measuredField = packet.search.query;
          const actualParams = new URLSearchParams(location.search);
          if (fieldKey(actualParams) === key) {
            for (const [name, value] of Object.entries(measuredField))
              actualParams.set(name, String(value));
            loadedFieldKey.current = fieldKey(actualParams);
            history.replaceState(null, "", `?${actualParams}`);
          }
          setQuery(measuredField);
          setDraft(measuredField);
          setRaText(String(measuredField.ra));
          setDecText(String(measuredField.dec));
          setSearch(packet.search);
          setFrames(packet.frames);
          return;
        }

        const found =
          source?.kind === "fits"
            ? null
            : await request<SearchResult>(`/api/search?${params}&limit=8`, {
                signal,
              });
        if (signal.aborted || job !== serial.current) return;
        setSearch(found);
        if (found) setQuery(found.query);
        const effectiveDetector = found?.query.detector ?? q.detector;
        const urls =
          source?.kind === "fits"
            ? source.urls
            : (found?.observations.map((o) => o.url) ?? []);
        if (!urls.length) return;
        let cursor = 0;
        let done = 0;
        let passed = 0;
        let timelineMin = Infinity;
        let timelineMax = -Infinity;
        const observations: Observation[] = [];
        const worker = async (batch: string[]) => {
          while (cursor < batch.length && !signal.aborted) {
            const url = batch[cursor++];
            try {
              const frameParams = new URLSearchParams({
                url,
                ra: String(q.ra),
                dec: String(q.dec),
                fov: String(q.fov),
                pixels: String(
                  source?.kind === "fits" ? (source.pixels ?? 96) : 96,
                ),
              });
              const loaded = await request<Frame>(`/api/frame?${frameParams}`, {
                signal,
              });
              if (signal.aborted || job !== serial.current) return;
              if (loaded.metadata.detector !== effectiveDetector)
                throw new Error(
                  `Detector D${loaded.metadata.detector} does not match the chosen D${effectiveDetector}.`,
                );
              passed++;
              if (loaded.metadata.badFraction < 0.9) {
                timelineMin = Math.min(timelineMin, loaded.metadata.mjd);
                timelineMax = Math.max(timelineMax, loaded.metadata.mjd);
              }
              observations.push({
                id: loaded.metadata.id,
                collection: url.includes("/dr1/")
                  ? "spherex_dr1"
                  : "spherex_qr3",
                detector: loaded.metadata.detector,
                mjd: loaded.metadata.mjd,
                date: loaded.metadata.date,
                url,
                metadataSource: "FITS header",
                metadataRetrievedAt: loaded.provenance.retrievedAt,
              });
              setFrames((previous) =>
                [...previous, loaded].sort(
                  (a, b) => a.metadata.mjd - b.metadata.mjd,
                ),
              );
            } catch (error) {
              if (!signal.aborted)
                setFailures((previous) => [
                  ...previous,
                  `${url.split("/").at(-1)}: ${(error as Error).message}`,
                ]);
            }
            done++;
            if (!signal.aborted && job === serial.current)
              setProgress(
                `Loaded ${passed} observation${passed === 1 ? "" : "s"} (${done} attempted)`,
              );
          }
        };
        await Promise.all([worker(urls), worker(urls)]);
        if (job !== serial.current || signal.aborted) return;
        if (
          found?.reserveObservations?.length &&
          passed < 8 &&
          (passed < 2 || timelineMax - timelineMin < 0.25)
        ) {
          const reserve = found.reserveObservations.slice(0, 8 - passed);
          cursor = 0;
          setProgress("Trying alternate exposures in this detector…");
          await worker(reserve.map((o) => o.url));
        }
        if (job !== serial.current || signal.aborted) return;
        if (source?.kind === "fits")
          setSearch({
            query: q,
            observations,
            totalAvailable: urls.length,
            truncated: false,
            queriedAt: new Date().toISOString(),
            source: "NASA/IPAC IRSA",
            status: "specified-observations",
            queryUrls: [],
            warnings: [source.label],
          });
      } catch (error) {
        if (!signal.aborted && job === serial.current)
          setError((error as Error).message);
      } finally {
        if (job === serial.current) setLoading(false);
      }
    },
    [],
  );
  useEffect(() => {
    let lookup: AbortController | undefined;
    const openLocationField = (useLoadedField = false) => {
      lookup?.abort();
      const parameters = new URLSearchParams(location.search);
      if (
        ["home", "survey", "atlas", "stats", "solar", "methods"].includes(
          initialPage(),
        )
      )
        return;
      if (useLoadedField && fieldKey(parameters) === loadedFieldKey.current)
        return;
      const query = initialQuery();
      const evidenceId = parameters.get("evidence");
      if (evidenceId) {
        const requestController = new AbortController();
        lookup = requestController;
        request<SurveySnapshot>("/survey.json", {
          signal: requestController.signal,
        })
          .then((snapshot) => {
            if (requestController.signal.aborted) return;
            const exact = snapshot.candidates.find(
              (candidate) => candidate.id === evidenceId,
            );
            if (!exact?.field || !exact.observations.length)
              throw new Error(
                "This finding is unavailable in the currently published survey.",
              );
            void load(
              exact.field,
              {
                kind: "fits",
                urls: exact.observations.map((o) => o.url),
                label: "Exact survey evidence selected by source URL.",
                pixels: exact.analysisPixels,
              },
              exact,
            );
          })
          .catch((error) => {
            if (!requestController.signal.aborted)
              setError((error as Error).message);
          });
        return;
      }
      const example = parameters.get("example");
      if (example !== null && EXAMPLE_PATHS[Number(example)]) {
        void load(query, {
          kind: "recorded",
          path: EXAMPLE_PATHS[Number(example)],
        });
      } else if (parameters.has("ra") || parameters.has("dec")) {
        const ra = parameters.get("ra") ?? "";
        const dec = parameters.get("dec") ?? "";
        try {
          void load({
            ...query,
            ra: parseCoordinate(ra, "ra"),
            dec: parseCoordinate(dec, "dec"),
          });
        } catch (error) {
          setRaText(ra);
          setDecText(dec);
          setInputError((error as Error).message);
        }
      } else void load(query, { kind: "recorded", path: EXAMPLE_PATHS[0] });
    };
    openLocationField();
    const pop = () => {
      setPage(initialPage());
      setSpatialFocus(initialFocus());
      setPlaying(false);
      openLocationField(true);
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      lookup?.abort();
      controller.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    if (!playing || timeline.length < 2) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setActiveUrl((current) => {
        const index = Math.max(
          0,
          timeline.findIndex((f) => f.provenance.sourceUrl === current),
        );
        return timeline[(index + 1) % timeline.length].provenance.sourceUrl;
      });
    }, speed);
    return () => clearInterval(timer);
  }, [playing, speed, timeline]);
  useEffect(() => {
    try {
      localStorage.setItem("slowtrace-notes", JSON.stringify(notes));
    } catch {
      toast.error(
        "Your browser could not save the notebook. Export it to keep a copy.",
      );
    }
  }, [notes]);
  const pointFor = useCallback(
    (f: Frame) => {
      if (point) return point;
      if (!candidateContext)
        return { x: Math.floor(f.width / 2), y: Math.floor(f.height / 2) };
      const epoch = candidateContext.evidence.epochMeasurements?.find(
        (e) => Math.abs(e.mjd - f.metadata.mjd) < 0.001,
      );
      return skyPixel(
        epoch?.ra ?? candidateContext.ra,
        epoch?.dec ?? candidateContext.dec,
        f.width,
        f.height,
        query,
      );
    },
    [point, candidateContext, query],
  );
  const measurements = useMemo(
    () =>
      frames.flatMap((f) => {
        const pixel = pointFor(f);
        if (!pixel) return [];
        const measurement = aperture(f, pixel.x, pixel.y);
        return measurement.value === null ? [] : [measurement];
      }),
    [frames, pointFor],
  );
  function navigate(p: Page, focus?: SpatialFocus) {
    setPage(p);
    setMobile(false);
    setPlaying(false);
    const params = new URLSearchParams(location.search);
    params.delete("candidate");
    setMoreOpen(false);
    if (p === "home") {
      if (page !== "home" || location.search || location.hash)
        history.pushState(null, "", "/");
      window.scrollTo(0, 0);
      return;
    }
    params.set("page", p);
    if (p === "atlas" || p === "solar") {
      const at =
        focus ??
        (candidateContext
          ? {
              ra: candidateContext.ra,
              dec: candidateContext.dec,
              label: candidateContext.id,
              id: candidateContext.id,
            }
          : { ra: query.ra, dec: query.dec });
      setSpatialFocus(at);
      params.set("focusRa", String(at.ra));
      params.set("focusDec", String(at.dec));
      if (at.label) params.set("focusLabel", at.label);
      else params.delete("focusLabel");
      if ("id" in at && at.id) params.set("focusId", at.id);
      else params.delete("focusId");
    }
    history.pushState(null, "", `?${params}`);
    if (p !== page) window.scrollTo(0, 0);
  }
  function openCandidateId(id: string) {
    setManualCandidate(null);
    navigate("survey");
    const params = new URLSearchParams(location.search);
    params.set("candidate", id);
    history.replaceState(null, "", `?${params}`);
  }
  function openDesk() {
    if (candidateContext && !loading) {
      const evidenceFiles = new Set(
        candidateContext.observations.map((o) => o.url),
      );
      if (
        !frames.length ||
        !frames.every((f) => evidenceFiles.has(f.provenance.sourceUrl))
      ) {
        openFinding(candidateContext, "observe");
        return;
      }
    }
    if (!frames.length && !loading) chooseTarget(0);
    else navigate("observe");
  }
  function go(id: Page) {
    if (id === "survey") setManualCandidate(null);
    if (id === "observe") return openDesk();
    navigate(id);
    if (TOOLS.some((tool) => tool.id === id) && !frames.length && !loading)
      void load(
        { ra: TARGETS[0].ra, dec: TARGETS[0].dec, detector: 1, fov: 5 },
        { kind: "recorded", path: EXAMPLE_PATHS[0] },
      );
  }
  function startTutorial() {
    setMobile(false);
    setMoreOpen(false);
    setFirstVisit(false);
    setTutorialOpen(true);
  }
  function closeTutorial() {
    setTutorialOpen(false);
    setFirstVisit(false);
    const url = new URL(location.href);
    if (url.searchParams.has("tutorial")) {
      url.searchParams.delete("tutorial");
      history.replaceState(null, "", url);
    }
  }
  function chooseTarget(index: number) {
    const target = TARGETS[index];
    navigate("observe");
    void load(
      { ra: target.ra, dec: target.dec, detector: index === 2 ? 6 : 1, fov: 5 },
      { kind: "recorded", path: EXAMPLE_PATHS[index] },
    );
  }
  function submitField(source?: LoadSource) {
    try {
      const ra = parseCoordinate(raText, "ra");
      const dec = parseCoordinate(decText, "dec");
      if (source?.kind === "fits" && draft.detector === 0)
        throw new Error(
          "Choose the detector used by the FITS files before loading them.",
        );
      navigate("observe");
      void load({ ...draft, ra, dec }, source);
    } catch (error) {
      setInputError((error as Error).message);
    }
  }
  function openFinding(candidate: Candidate, view: Page) {
    if (view === "atlas" || view === "solar") {
      setCandidateContext(candidate);
      navigate(view, {
        ra: candidate.ra,
        dec: candidate.dec,
        label: candidate.id,
        id: candidate.id,
      });
      return;
    }
    navigate(view);
    const field = candidate.field;
    const urls = candidate.observations.map((o) => o.url);
    if (field && urls.length) {
      void load(
        field,
        {
          kind: "fits",
          urls,
          label: "Exact survey evidence selected by source URL.",
          pixels: candidate.analysisPixels,
        },
        candidate,
      );
    } else {
      setCandidateContext(candidate);
    }
  }
  function saveNote() {
    if (!note.trim()) {
      toast.error("Write an observation first.");
      return;
    }
    setNotes((n) => [
      {
        id: crypto.randomUUID(),
        created: new Date().toISOString(),
        ...selected,
        text: note.trim(),
        classification,
        sourceIds: frames.map((f) => f.metadata.id),
        candidateId: candidateContext?.id,
      },
      ...n,
    ]);
    setNote("");
    toast.success("Saved in your local research notebook");
  }
  function report() {
    const r = {
      schemaVersion: "slowtrace-x/1.0",
      createdAt: new Date().toISOString(),
      kind: "preliminary-research-record",
      query,
      selection: selected,
      linkedCandidate: candidateContext?.id,
      archive: search,
      observations: frames.map((f) => ({
        metadata: f.metadata,
        provenance: f.provenance,
        warnings: f.warnings,
      })),
      apertureMeasurements: measurements,
      analysis: result,
      experiment,
      notes,
      followup: plan,
      limitations: [
        "Candidate scores are exploratory measurements, not discovery probabilities.",
        "WCS-WAVE wavelengths and aperture measurements are for exploratory visualization.",
        "No confirmed discovery, calibrated spectrum, or orbital solution is claimed.",
      ],
    };
    download("slowtrace-x-evidence.json", r);
    toast.success("Evidence report exported with source provenance");
  }
  async function run(kind: "analyze" | "experiment") {
    setWorking(kind);
    const job = serial.current;
    try {
      const baseline = frames.at(-1)!.metadata.mjd - frames[0].metadata.mjd;
      const bound = Math.min(
        maxSpeed,
        (query.fov * 60) / (3.1 * Math.max(0.01, baseline)),
      );
      const steps = [-bound, -bound / 2, 0, bound / 2, bound];
      const velocities = steps.flatMap((y) => steps.map((x) => [x, y]));
      const payload = {
        ...query,
        urls: frames.map((f) => f.provenance.sourceUrl),
        pixels: frame.width,
        threshold,
        seed,
        velocities,
        injectedSnr: injectionSnr,
        motion: [bound, 0],
      };
      const r = await post<Result>(`/api/${kind}`, payload);
      if (job !== serial.current) return;
      if (kind === "analyze")
        setResult({
          ...r,
          candidates: r.candidates.map((c: Result) => ({
            ...c,
            ...pixelSky(c.x, c.y, r.width, r.height, query),
          })),
        });
      else setExperiment(r);
      toast.success(
        kind === "analyze" ? "Analysis complete" : "Experiment complete",
      );
    } catch (e) {
      toast.error((e as Error).message, { duration: 9000 });
    } finally {
      setWorking("");
    }
  }
  function investigatePeak(peak: Result, analysis: Result) {
    const referenceMjd = Number(analysis.referenceMjd);
    const width = Number(analysis.width);
    const height = Number(analysis.height);
    const epochMeasurements = (analysis.selectedFrameIndices as number[]).map(
      (index) => {
        const meta = analysis.observationMetadata[index];
        const dt = Number(meta.mjd) - referenceMjd;
        const x = peak.x + (peak.velocityWestArcsecDay * dt) / meta.pixelArcsec;
        const y =
          peak.y + (peak.velocitySouthArcsecDay * dt) / meta.pixelArcsec;
        const pos = pixelSky(x, y, width, height, query);
        return {
          ...pos,
          mjd: meta.mjd,
          positionKind: "predicted-track",
          wavelengthUm: meta.wavelengthCenter,
          observerState: meta.observerState,
        };
      },
    );
    const id = `trace-${query.ra.toFixed(6)}-${query.dec.toFixed(6)}-${query.detector}-${Math.round(referenceMjd * 10000)}-${peak.x}-${peak.y}-${peak.velocityWestArcsecDay}-${peak.velocitySouthArcsecDay}`;
    setManualCandidate({
      id,
      ra: peak.ra,
      dec: peak.dec,
      referenceMjd,
      evidence: {
        ...peak,
        epochMeasurements,
        sourceUrls: analysis.request?.urls,
        observationProvenance: analysis.observationProvenance,
      },
    });
    navigate("survey");
  }
  async function calculatePlan() {
    setWorking("plan");
    try {
      setPlan(
        await post<Result>("/api/plan", {
          ra: selected.ra,
          dec: selected.dec,
          latitude: lat,
          longitude: lon,
          date: planDate,
        }),
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setWorking("");
    }
  }
  const trialPixels =
    showTrack && frame && candidateContext?.evidence.epochMeasurements?.length
      ? candidateContext.evidence.epochMeasurements.flatMap((epoch) => {
          const position = skyPixel(
            epoch.ra,
            epoch.dec,
            frame.width,
            frame.height,
            query,
          );
          return position ? [position] : [];
        })
      : undefined;
  const researchPage = TOOLS.some((tool) => tool.id === page);
  const warnings = [...(search?.warnings || []), ...(frame?.warnings || [])];
  return (
    <Tooltip.Provider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="app-shell">
        <div
          className={`workspace mission-workspace${page === "home" ? " is-mission" : ""}`}
        >
          {page === "home" ? (
            <MissionHeader
              mobile={mobile}
              toggleMenu={() => setMobile(!mobile)}
              go={go}
            />
          ) : (
            <header className="navbar">
              <button
                className="navbar-brand"
                onClick={() => go("home")}
                aria-label="SLOWTRACE X home"
              >
                <img src="/mark.svg" alt="" />
                SLOWTRACE X
              </button>
              <nav
                aria-label="Main navigation"
                className={`navbar-nav ${mobile ? "open" : ""}`}
              >
                {NAV.map(({ id, label }) => (
                  <button
                    key={id}
                    className={page === id ? "active" : ""}
                    aria-current={page === id ? "page" : undefined}
                    onClick={() => go(id)}
                  >
                    {label}
                  </button>
                ))}
                <div className="navbar-more">
                  <button
                    className={MORE.some((m) => m.id === page) ? "active" : ""}
                    aria-haspopup="true"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen(!moreOpen)}
                  >
                    More <ChevronDown size={14} />
                  </button>
                  <div className={`navbar-more-menu ${moreOpen ? "open" : ""}`}>
                    {MORE.map(({ id, label }) => (
                      <button
                        key={id}
                        className={page === id ? "active" : ""}
                        aria-current={page === id ? "page" : undefined}
                        onClick={() => go(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </nav>
              <TutorialButton
                onClick={startTutorial}
                firstVisit={firstVisit && !tutorialOpen}
              />
              <button
                className="navbar-menu"
                aria-expanded={mobile}
                aria-label={mobile ? "Close navigation" : "Open navigation"}
                onClick={() => setMobile(!mobile)}
              >
                {mobile ? <X size={18} /> : <Menu size={18} />}
              </button>
            </header>
          )}
          <main id="main" className={`view-${page}`}>
            {page === "home" && (
              <MissionHome
                onNavigate={navigate}
                onExample={chooseTarget}
                onTutorial={startTutorial}
                firstVisit={firstVisit && !tutorialOpen}
              />
            )}
            {page !== "home" && page !== "atlas" && (
              <div className={`page-heading ${page === "observe" ? "sr-only" : ""}`}>
                <div>
                  <h1>{TITLES[page][0]}</h1>
                  <p>{TITLES[page][1]}</p>
                </div>
              </div>
            )}
            {researchPage && (
              <div className="ob-top">
                <div className="ob-picks" aria-label="Challenge targets">
                  <span>Targets</span>
                  {TARGETS.map((t, i) => (
                    <button
                      key={t.name}
                      className={target?.name === t.name ? "selected" : ""}
                      aria-pressed={target?.name === t.name}
                      title={t.type}
                      onClick={() => chooseTarget(i)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
                <form
                  className="ob-query"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitField();
                  }}
                >
                  <label>
                    <span>RA</span>
                    <input
                      aria-label="Right ascension, degrees or hours minutes seconds"
                      title="ICRS. Decimal degrees or 08h55m10.831s"
                      type="text"
                      required
                      value={raText}
                      onChange={(e) => setRaText(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Dec</span>
                    <input
                      aria-label="Declination, decimal or sexagesimal degrees"
                      title="ICRS. Decimal degrees or −07d14m42.53s"
                      type="text"
                      required
                      value={decText}
                      onChange={(e) => setDecText(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Field</span>
                    <select
                      aria-label="Field of view"
                      value={draft.fov}
                      onChange={(e) =>
                        setDraft({ ...draft, fov: Number(e.target.value) })
                      }
                    >
                      {[2, 5, 10, 15, 30].map((n) => (
                        <option key={n} value={n}>
                          {n}′
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Band</span>
                    <select
                      aria-label="Detector"
                      value={draft.detector}
                      onChange={(e) =>
                        setDraft({ ...draft, detector: Number(e.target.value) })
                      }
                    >
                      <option value={0}>Auto</option>
                      {DETECTORS.map((d, i) => (
                        <option key={d} value={i + 1}>
                          D{i + 1} {d} µm
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={loading}
                    title="Search the NASA/IPAC archive at this position"
                  >
                    {loading ? "Loading…" : "Search archive"}
                  </button>
                </form>
                {inputError && (
                  <div className="load-status error" role="alert">
                    {inputError}
                  </div>
                )}
                {page === "observe" && (
                  <Suspense fallback={null}>
                    <AutomaticDetection
                      raText={raText}
                      decText={decText}
                      fov={draft.fov}
                      detector={draft.detector}
                    />
                  </Suspense>
                )}
              </div>
            )}
            {candidateContext && page !== "survey" && (
              <div className="load-status">
                <Radar size={15} /> Survey evidence · {candidateContext.id} ·
                ICRS {fmt(candidateContext.ra, 6)}°,{" "}
                {fmt(candidateContext.dec, 6)}°
              </div>
            )}
            {page === "survey" && (
              <Suspense
                fallback={
                  <div className="load-status">Loading survey records…</div>
                }
              >
                <SurveyDesk
                  manual={manualCandidate}
                  onOpen={(candidate, view) => openFinding(candidate, view)}
                />
              </Suspense>
            )}
            {page === "observe" &&
              !loading &&
              !error &&
              search &&
              search.status !== "recorded-observations" && (
                <ArchiveStatus
                  search={search}
                  loaded={frames.length}
                  failed={failures.length}
                  onRetry={() =>
                    void load({
                      ...query,
                      detector: search.requestedDetector ?? query.detector,
                    })
                  }
                  onDetector={(detector) => void load({ ...query, detector })}
                />
              )}
            {researchPage && (loading || error) && (
              <div
                className={`load-status ${error ? "error" : ""}`}
                role="status"
              >
                {loading ? (
                  <LoaderCircle className="spinner" size={15} />
                ) : (
                  <CircleHelp size={15} />
                )}
                <span>{error || progress}</span>
                {loading && (
                  <button
                    onClick={() => {
                      controller.current?.abort();
                      setLoading(false);
                      setProgress("Retrieval stopped");
                    }}
                  >
                    Stop retrieval
                  </button>
                )}
              </div>
            )}
            {page === "observe" && (
              <div className="ob-grid">
                <section className="ob-viewer" aria-label="Blink player">
                  <div className="ob-viewer-head">
                    <h2>{fieldName}</h2>
                    <span className="mono">
                      {fmt(query.ra, 5)}° {fmt(query.dec, 5)}°
                    </span>
                    <span className="ob-source">
                      {frame
                        ? search?.status === "recorded-observations"
                          ? "Recorded NASA data"
                          : search?.status === "recorded-metadata"
                            ? "NASA pixels, recorded index"
                            : search?.status === "partial-live" ||
                                search?.searchCoverage?.complete === false
                              ? "NASA pixels, partial search"
                              : "NASA archive"
                        : "No data"}
                    </span>
                  </div>
                  <div className="ob-toolbar">
                    <div className="seg" aria-label="Comparison mode">
                      {["blink", "difference", "overlay", "split"].map((m) => (
                        <button
                          key={m}
                          className={mode === m ? "selected" : ""}
                          aria-pressed={mode === m}
                          onClick={() => {
                            setMode(m);
                            setPlaying(false);
                          }}
                        >
                          {m === "blink"
                            ? "Blink"
                            : m === "difference"
                              ? "Difference"
                              : m === "overlay"
                                ? "Overlay"
                                : "Side by side"}
                        </button>
                      ))}
                    </div>
                    <select
                      aria-label="Colour palette"
                      value={palette}
                      onChange={(e) => setPalette(e.target.value)}
                    >
                      <option value="ice">Ice</option>
                      <option value="mono">Gray</option>
                    </select>
                  </div>
                  <div
                    className={`ob-stage ${mode === "split" ? "split-view" : ""}`}
                  >
                      {mode === "split" && (
                        <div>
                          <SkyCanvas
                            frame={reference}
                            mode="blink"
                            contrast={contrast}
                            palette={palette}
                            scale={commonStretch}
                            quality={qualityLayer}
                            track={trialPixels}
                            point={
                              point ||
                              (candidateContext && reference
                                ? pointFor(reference)
                                : null)
                            }
                            onPoint={setPoint}
                          />
                          <div className="split-label">
                            Reference ·{" "}
                            {reference ? date(reference.metadata.mjd) : "—"}
                          </div>
                        </div>
                      )}
                      <div>
                        <SkyCanvas
                          frame={frame}
                          reference={reference}
                          mode={
                            mode === "difference" && !comparison.eligible
                              ? "blink"
                              : mode
                          }
                          contrast={contrast}
                          palette={palette}
                          scale={commonStretch}
                          quality={qualityLayer}
                          track={trialPixels}
                          overlayOpacity={blend}
                          point={
                            point ||
                            (candidateContext && frame ? pointFor(frame) : null)
                          }
                          onPoint={setPoint}
                        />
                        {mode === "split" && (
                          <div className="split-label">
                            Selected · {frame ? date(frame.metadata.mjd) : "—"}
                          </div>
                        )}
                      </div>
                  </div>
                  <div className="ob-play">
                    <button
                      className="btn btn-icon ob-playbtn"
                      aria-label={playing ? "Pause blink" : "Play blink"}
                      title={
                        mode !== "blink"
                          ? "Switch to Blink to play"
                          : playing
                            ? "Pause"
                            : "Play"
                      }
                      disabled={timeline.length < 2 || mode !== "blink"}
                      onClick={() => setPlaying(!playing)}
                    >
                      {playing ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button
                      className="btn btn-icon"
                      aria-label="Previous epoch"
                      disabled={timeline.length < 2}
                      onClick={() =>
                        selectEpoch(
                          (active - 1 + timeline.length) % timeline.length,
                        )
                      }
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      className="btn btn-icon"
                      aria-label="Next epoch"
                      disabled={timeline.length < 2}
                      onClick={() => selectEpoch((active + 1) % timeline.length)}
                    >
                      <ChevronRight size={14} />
                    </button>
                    <input
                      className="ob-scrub"
                      aria-label="Observation epoch"
                      type="range"
                      min="0"
                      max={Math.max(0, timeline.length - 1)}
                      value={active}
                      disabled={!timeline.length}
                      aria-valuetext={frame?.metadata.date}
                      onChange={(e) => selectEpoch(Number(e.target.value))}
                    />
                    <span className="ob-epoch mono">
                      {timeline.length ? active + 1 : 0}/{timeline.length}
                      <b>{frame ? date(frame.metadata.mjd) : "—"}</b>
                    </span>
                    <select
                      aria-label="Blink speed"
                      title="Blink speed"
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                    >
                      <option value={1400}>0.7 fps</option>
                      <option value={900}>1.1 fps</option>
                      <option value={400}>2.5 fps</option>
                    </select>
                  </div>
                  {timeline.length > 1 && (
                    <div className="ob-epochs" aria-label="Observation dates">
                      {timeline.map((f, index) => (
                        <button
                          key={f.provenance.sourceUrl}
                          aria-pressed={index === active}
                          onClick={() => selectEpoch(index)}
                          title={f.metadata.date + " UTC"}
                        >
                          {date(f.metadata.mjd)}
                          <span>{fmt(f.metadata.wavelengthCenter, 3)} µm</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {mode === "difference" && (
                    <p className="ob-note" role="status">
                      {comparison.eligible
                        ? `Selected minus reference. ${comparison.reason}`
                        : `Subtraction unavailable, showing the selected image. ${comparison.reason}`}
                    </p>
                  )}
                  {mode !== "difference" &&
                    frame &&
                    reference &&
                    frame !== reference &&
                    !comparison.eligible && (
                      <p className="ob-note">{comparison.reason}</p>
                    )}
                </section>
                <aside className="ob-side">
                  <section>
                    <h3>Field</h3>
                    <dl className="kv">
                      <div>
                        <dt>Epochs</dt>
                        <dd>{frames.length}</dd>
                      </div>
                      <div>
                        <dt>Baseline</dt>
                        <dd>
                          {frames.length > 1
                            ? `${fmt(frames.at(-1)!.metadata.mjd - frames[0].metadata.mjd, 0)} d`
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Release</dt>
                        <dd>
                          {search?.observations.length
                            ? [
                                ...new Set(
                                  search.observations.map((o) =>
                                    o.collection
                                      .replace("spherex_", "")
                                      .toUpperCase(),
                                  ),
                                ),
                              ].join(" + ")
                            : "DR1 + QR3"}
                        </dd>
                      </div>
                      <div>
                        <dt>Band</dt>
                        <dd>
                          {query.detector
                            ? `D${query.detector} ${DETECTORS[query.detector - 1]} µm`
                            : "Auto"}
                        </dd>
                      </div>
                      <div>
                        <dt title="Local wavelength range of the selected exposure">
                          Wavelength
                        </dt>
                        <dd>
                          {frame
                            ? `${fmt(frame.metadata.wavelengthMin, 3)}–${fmt(frame.metadata.wavelengthMax, 3)} µm`
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Valid pixels</dt>
                        <dd>
                          {frame
                            ? `${fmt((1 - frame.metadata.badFraction) * 100, 1)}%`
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt title="Zodiacal light model">Zodi</dt>
                        <dd>
                          {frame
                            ? frame.metadata.zodiSubtracted
                              ? "Subtracted"
                              : "Not subtracted"
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Pixel scale</dt>
                        <dd>
                          {frame ? `${fmt(frame.metadata.pixelArcsec)}″` : "—"}
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section>
                    <h3>Display</h3>
                    <div className="ob-controls">
                      {frames.length > 1 && (
                        <label className="ob-field">
                          <span>Reference</span>
                          <select
                            aria-label="Reference observation"
                            value={reference?.provenance.sourceUrl ?? ""}
                            onChange={(e) => {
                              setReferenceUrl(e.target.value);
                              setPlaying(false);
                            }}
                          >
                            {frames.map((f) => (
                              <option
                                key={f.provenance.sourceUrl}
                                value={f.provenance.sourceUrl}
                              >
                                {date(f.metadata.mjd)} ·{" "}
                                {fmt(f.metadata.wavelengthCenter, 3)} µm
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="ob-field">
                        <span title="Changes visibility, not the data">
                          Stretch
                        </span>
                        <input
                          aria-label="Display stretch"
                          type="range"
                          min=".4"
                          max="3"
                          step=".1"
                          value={contrast}
                          onChange={(e) => setContrast(Number(e.target.value))}
                        />
                      </label>
                      {mode === "overlay" && (
                        <label className="ob-field">
                          <span>Opacity</span>
                          <input
                            aria-label="Reference opacity"
                            type="range"
                            min="0"
                            max="1"
                            step=".05"
                            value={blend}
                            onChange={(e) => setBlend(Number(e.target.value))}
                          />
                        </label>
                      )}
                      {frames.length > 1 && (
                        <label
                          className="ob-check"
                          title="Only step through epochs whose bandpass is close to the reference"
                        >
                          <input
                            type="checkbox"
                            checked={matchedOnly}
                            onChange={(e) => {
                              setMatchedOnly(e.target.checked);
                              setPlaying(false);
                            }}
                          />
                          Matched bandpass only
                        </label>
                      )}
                      {frame && (
                        <label
                          className="ob-check"
                          title="Highlight pixels excluded by quality flags"
                        >
                          <input
                            type="checkbox"
                            checked={qualityLayer}
                            onChange={(e) => setQualityLayer(e.target.checked)}
                          />
                          Flagged pixels
                        </label>
                      )}
                      {frame && candidateContext && (
                        <label className="ob-check">
                          <input
                            type="checkbox"
                            checked={showTrack}
                            onChange={(e) => setShowTrack(e.target.checked)}
                          />
                          Trial path
                        </label>
                      )}
                    </div>
                  </section>
                  <section className="ob-actions">
                    <button
                      className="btn"
                      onClick={() => navigate("trace")}
                      disabled={frames.length < 2}
                      title="Run the DeepTrace motion search on these epochs"
                    >
                      Motion search
                    </button>
                    <button className="btn" onClick={() => navigate("spectra")}>
                      Spectrum
                    </button>
                    <button
                      className="btn"
                      onClick={() =>
                        navigate("atlas", {
                          ...selected,
                          label: fieldName,
                          id: candidateContext?.id,
                        })
                      }
                    >
                      Sky Atlas
                    </button>
                    <button
                      className="btn"
                      onClick={() => navigate("notebook")}
                    >
                      Add note
                    </button>
                    <button
                      className="btn"
                      onClick={report}
                      title="Download a JSON evidence report with provenance"
                    >
                      Export
                    </button>
                  </section>
                  {frame && (
                    <details>
                      <summary>Exposure details</summary>
                      <dl className="kv">
                        <div>
                          <dt>Observed UTC</dt>
                          <dd>{frame.metadata.date}</dd>
                        </div>
                        <div>
                          <dt>Retrieved UTC</dt>
                          <dd>{frame.provenance.retrievedAt}</dd>
                        </div>
                        <div>
                          <dt>Method</dt>
                          <dd>{frame.provenance.method}</dd>
                        </div>
                        <div>
                          <dt>Calibration</dt>
                          <dd>
                            {frame.metadata.calibrationVersion ||
                              "See FITS header"}
                          </dd>
                        </div>
                        <div>
                          <dt>Flags</dt>
                          <dd>
                            {Array.isArray(frame.metadata.flagsPresent)
                              ? frame.metadata.flagsPresent.join(", ")
                              : "See FITS header"}
                          </dd>
                        </div>
                        <div>
                          <dt>Masked</dt>
                          <dd>{fmt(frame.metadata.badFraction * 100, 1)}%</dd>
                        </div>
                        <div>
                          <dt>Processing</dt>
                          <dd>
                            {String(
                              frame.provenance.pipeline ||
                                "See exported provenance",
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>SHA-256</dt>
                          <dd className="checksum">
                            {String(
                              frame.provenance.processedSha256 ||
                                frame.provenance.sha256 ||
                                "Unavailable",
                            )}
                          </dd>
                        </div>
                      </dl>
                      <a
                        className="ob-link"
                        href={
                          frame.provenance.cutoutUrl ||
                          frame.provenance.sourceUrl
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        {frame.metadata.id} (FITS)
                      </a>
                    </details>
                  )}
                  <AladinPanel
                    ra={query.ra}
                    dec={query.dec}
                    fovArcmin={query.fov}
                  />
                  <details>
                    <summary>About this field</summary>
                    <p>
                      {target
                        ? `${target.type}. ${target.note}`
                        : "Custom position. Click a source in the image to select it for spectra or notes."}
                    </p>
                    <p>
                      Images are WCS aligned, north up, on a shared stretch.
                      Flagged pixels are excluded. Differences between epochs
                      can come from wavelength, calibration, or artifacts as
                      well as real change. An unusual signal is a question, not
                      a discovery.
                    </p>
                  </details>
                  <details className="archive-tools">
                    <summary>Coordinate formats and FITS URLs</summary>
                    <p>
                      ICRS decimal degrees, or sexagesimal such as{" "}
                      <code>08h55m10.831s</code> <code>−07d14m42.53s</code>. If
                      archive search is down, load cutouts from specific
                      exposure files.
                    </p>
                <label className="stacked-label">
                  Official DR1 or QR3 FITS file URLs, one per line
                  <textarea
                    rows={3}
                    value={fitsText}
                    onChange={(e) => setFitsText(e.target.value)}
                  />
                </label>
                <button
                  className="secondary"
                  disabled={loading || !fitsText.trim()}
                  onClick={() => {
                    try {
                      submitField({
                        kind: "fits",
                        urls: archiveFitsUrls(fitsText),
                        label:
                          "User-specified NASA FITS files. No archive metadata search was used.",
                      });
                    } catch (error) {
                      setInputError((error as Error).message);
                    }
                  }}
                >
                  Load specified exposures
                </button>
                  </details>
                </aside>
              </div>
            )}
            {page === "atlas" && (
              <Suspense
                fallback={
                  <div className="load-status">Opening celestial atlas…</div>
                }
              >
                <Atlas
                  query={query}
                  targets={TARGETS}
                  focus={spatialFocus}
                  onCandidate={openCandidateId}
                  onNavigate={(ra, dec) => {
                    navigate("observe");
                    void load({ ...query, ra, dec, detector: 0 });
                  }}
                />
              </Suspense>
            )}
            {page === "stats" && (
              <Suspense
                fallback={
                  <div className="load-status">
                    Loading measured statistics…
                  </div>
                }
              >
                <Statistics
                  onCandidate={openCandidateId}
                  onAtlas={(ra, dec, label) =>
                    navigate("atlas", { ra, dec, label })
                  }
                  onLab={() => navigate("lab")}
                />
              </Suspense>
            )}
            {page === "solar" && (
              <Suspense
                fallback={
                  <div className="load-status">Loading JPL ephemerides…</div>
                }
              >
                <SolarSystem
                  focus={spatialFocus?.id ? spatialFocus : undefined}
                  onCandidate={openCandidateId}
                  onObserve={(ra, dec) => {
                    navigate("observe");
                    void load({ ...query, ra, dec, detector: 0 });
                  }}
                />
              </Suspense>
            )}
            {page === "spectra" && (
              <section className="panel tool-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">
                      102-CHANNEL MISSION / AVAILABLE SAMPLES
                    </span>
                    <h2>A spectrum begins with measurements.</h2>
                  </div>
                  <div className="segmented">
                    <button
                      className={
                        spectralAxis === "wavelength" ? "selected" : ""
                      }
                      onClick={() => setSpectralAxis("wavelength")}
                    >
                      Wavelength
                    </button>
                    <button
                      className={spectralAxis === "mjd" ? "selected" : ""}
                      onClick={() => setSpectralAxis("mjd")}
                    >
                      Time
                    </button>
                  </div>
                </div>
                <Notice>
                  Showing {measurements.length} measured samples from the loaded
                  detector, not a fabricated 102-point spectrum. WCS-WAVE
                  wavelengths are approximate. Aperture means are
                  local-background subtracted; errors omit pixel covariance and
                  calibration systematics.
                </Notice>
                {measurements.length ? (
                  <Suspense fallback={<div className="chart" />}>
                    <SpectrumChart
                      data={measurements.filter(
                        (m) =>
                          spectralAxis !== "wavelength" ||
                          m.wavelength !== null,
                      )}
                      axis={spectralAxis}
                    />
                  </Suspense>
                ) : (
                  <Empty
                    icon={<Waves size={32} />}
                    text="Load observations to measure the selected sky position."
                  />
                )}
                <div className="tool-footer">
                  <span>
                    Position {fmt(selected.ra, 5)}°, {fmt(selected.dec, 5)}° ·
                    radius 2 output pixels
                  </span>
                  <button
                    className="secondary"
                    onClick={() =>
                      download("slowtrace-spectral-samples.json", {
                        query,
                        selection: selected,
                        measurements,
                        method:
                          "Radius-2-pixel aperture mean minus median annulus (r=4–7); approximate errors.",
                      })
                    }
                    disabled={!measurements.length}
                  >
                    <ArrowDownToLine size={15} /> Export measurements
                  </button>
                </div>
                <p className="caption">
                  Select a source at the observation desk. Choose another
                  detector above to inspect a different infrared range. Changes
                  between different wavelengths are not a light curve.
                </p>
              </section>
            )}
            {page === "trace" && (
              <section className="panel tool-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">
                      DEEPTRACE / EXPERIMENTAL SEARCH
                    </span>
                    <h2>Make coherent motion stand out.</h2>
                  </div>
                  <span className="tag">
                    Measured evidence · no discovery probability
                  </span>
                </div>
                <p className="tool-intro">
                  Weight aligned exposures by inverse variance and combine them
                  along trial motion vectors. Compare each peak against a
                  stationary stack. The search ranks residual peaks using
                  noise-weighted evidence and checks whether the observations
                  are comparable.
                </p>
                <div className="control-grid">
                  <label>
                    Maximum trial motion
                    <input
                      type="number"
                      min=".01"
                      max="20"
                      step=".1"
                      value={maxSpeed}
                      onChange={(e) => setMaxSpeed(e.target.valueAsNumber)}
                    />
                    <small>arcsec / day, each axis</small>
                  </label>
                  <label>
                    Detection threshold
                    <input
                      type="number"
                      min="3"
                      max="12"
                      step=".5"
                      value={threshold}
                      onChange={(e) => setThreshold(e.target.valueAsNumber)}
                    />
                    <small>nominal signal-to-noise</small>
                  </label>
                  <div className="control-action">
                    <button
                      className="primary"
                      disabled={frames.length < 2 || !!working}
                      onClick={() => void run("analyze")}
                    >
                      {working === "analyze" ? (
                        <LoaderCircle className="spinner" size={17} />
                      ) : (
                        <ScanLine size={17} />
                      )}{" "}
                      Run DeepTrace
                    </button>
                    <small>
                      {frames.length} real exposures available · at least 2
                      required
                    </small>
                  </div>
                </div>
                {result ? (
                  <ScientificResult
                    result={result}
                    onInvestigate={(peak) => investigatePeak(peak, result)}
                  />
                ) : (
                  <Empty
                    icon={<ScanLine size={32} />}
                    text="No search has been run on this field yet."
                  />
                )}
                <Notice>
                  A residual can be a star, a detector artifact, a bandpass
                  mismatch, or a moving source. Gaussian filtering is an
                  approximation to the instrument PSF. Trial searches and
                  resampling affect significance; the displayed S/N is not a
                  false-alarm probability.
                </Notice>
                <div className="tool-footer">
                  <button
                    className="text-button"
                    onClick={() => navigate("lab")}
                  >
                    <FlaskConical size={16} /> Test recovery on these images{" "}
                    <ArrowRight size={14} />
                  </button>
                  <button
                    className="secondary"
                    disabled={!result}
                    onClick={() => download("slowtrace-analysis.json", result)}
                  >
                    <ArrowDownToLine size={15} /> Export analysis
                  </button>
                </div>
              </section>
            )}
            {page === "lab" && (
              <section className="panel tool-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">
                      CONTROLLED EXPERIMENT / REAL BACKGROUNDS
                    </span>
                    <h2>Put the search to the test.</h2>
                  </div>
                  <span className="tag amber">
                    Synthetic injections clearly identified
                  </span>
                </div>
                <p className="tool-intro">
                  Inject artificial moving sources into the loaded NASA
                  observations. Compare motion-aware recovery with a
                  stationary-stack baseline using the same positions, noise, and
                  detection thresholds.
                </p>
                <div className="control-grid">
                  <label>
                    Random seed
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      value={seed}
                      onChange={(e) => setSeed(e.target.valueAsNumber)}
                    />
                    <small>Repeat the same controlled trial</small>
                  </label>
                  <label>
                    Trial speed range
                    <input
                      type="number"
                      min=".01"
                      max="20"
                      step=".1"
                      value={maxSpeed}
                      onChange={(e) => setMaxSpeed(e.target.valueAsNumber)}
                    />
                    <small>arcsec / day</small>
                  </label>
                  <label>
                    Injected signal-to-noise
                    <input
                      type="number"
                      min=".5"
                      max="15"
                      step=".5"
                      value={injectionSnr}
                      onChange={(e) => setInjectionSnr(e.target.valueAsNumber)}
                    />
                    <small>Approximate single-exposure S/N</small>
                  </label>
                  <div className="control-action">
                    <button
                      className="primary"
                      disabled={frames.length < 2 || !!working}
                      onClick={() => void run("experiment")}
                    >
                      {working === "experiment" ? (
                        <LoaderCircle className="spinner" size={17} />
                      ) : (
                        <FlaskConical size={17} />
                      )}{" "}
                      Run recovery experiment
                    </button>
                    <small>Measured outcomes, including failures</small>
                  </div>
                </div>
                {experiment ? (
                  <ScientificResult result={experiment} />
                ) : (
                  <Empty
                    icon={<FlaskConical size={32} />}
                    text="Your experiment results will appear after the calculation."
                  />
                )}
                <Notice>
                  Injected objects are synthetic; the image backgrounds are
                  real. This small conditional experiment is not a blind survey
                  benchmark. Improvements are reported only when measured in
                  this run.
                </Notice>
                <div className="tool-footer">
                  <span>
                    Recorded seed, parameters, controls, and source provenance
                  </span>
                  <button
                    className="secondary"
                    disabled={!experiment}
                    onClick={() =>
                      download("slowtrace-experiment.json", experiment)
                    }
                  >
                    <ArrowDownToLine size={15} /> Export reproducible run
                  </button>
                </div>
              </section>
            )}
            {page === "notebook" && (
              <div className="notebook-grid">
                <section className="panel tool-panel">
                  <span className="eyebrow">
                    A HUMAN LOOK IS PART OF THE METHOD
                  </span>
                  <h2>Record what you see.</h2>
                  <p className="muted">
                    Selected position: {fmt(selected.ra, 6)}°,{" "}
                    {fmt(selected.dec, 6)}°. Records are saved in this browser,
                    with source IDs attached.
                  </p>
                  <label className="stacked-label">
                    Observation type
                    <select
                      value={classification}
                      onChange={(e) => setClassification(e.target.value)}
                    >
                      {[
                        "Needs investigation",
                        "Possible motion",
                        "Brightness change",
                        "Likely artifact",
                        "No visible change",
                      ].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label className="stacked-label">
                    Your observation
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Which epochs did you compare? What changed? What might explain it?"
                      rows={5}
                    />
                  </label>
                  <button className="primary" onClick={saveNote}>
                    <NotebookPen size={16} /> Save observation
                  </button>
                  <Notice>
                    These are personal research notes. They are not submitted to
                    NASA, the Minor Planet Center, or a public review network.
                  </Notice>
                </section>
                <section className="panel tool-panel">
                  <div className="section-title">
                    <h2>
                      Research log <span className="count">{notes.length}</span>
                    </h2>
                    <button
                      className="icon-button"
                      aria-label="Export notebook"
                      onClick={() => download("slowtrace-notebook.json", notes)}
                    >
                      <ArrowDownToLine size={18} />
                    </button>
                  </div>
                  {!notes.length ? (
                    <Empty
                      icon={<NotebookPen size={29} />}
                      text="A good question is worth keeping."
                    />
                  ) : (
                    notes.map((n) => (
                      <article className="note" key={n.id}>
                        <span className="tag small">{n.classification}</span>
                        <p>{n.text}</p>
                        <small>
                          {date(n.created)} · {fmt(n.ra, 4)}°, {fmt(n.dec, 4)}°
                          {n.candidateId ? ` · ${n.candidateId}` : ""}·{" "}
                          {n.sourceIds.length} source files
                        </small>
                        <button
                          className="text-button"
                          onClick={() => {
                            setNotes((v) => v.filter((x) => x.id !== n.id));
                            toast("Observation removed", {
                              action: {
                                label: "Undo",
                                onClick: () => setNotes((v) => [n, ...v]),
                              },
                            });
                          }}
                        >
                          Remove
                        </button>
                      </article>
                    ))
                  )}
                </section>
              </div>
            )}
            {page === "planner" && (
              <section className="panel tool-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">
                      FOLLOW-UP / FIXED SKY POSITION
                    </span>
                    <h2>Find a window to observe.</h2>
                  </div>
                  <Compass size={26} />
                </div>
                <div className="control-grid four">
                  <label>
                    Latitude, degrees
                    <input
                      type="number"
                      min="-90"
                      max="90"
                      step="any"
                      value={lat}
                      onChange={(e) => setLat(e.target.valueAsNumber)}
                    />
                  </label>
                  <label>
                    Longitude, east positive
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      step="any"
                      value={lon}
                      onChange={(e) => setLon(e.target.valueAsNumber)}
                    />
                  </label>
                  <label>
                    UTC date
                    <input
                      type="date"
                      value={planDate}
                      onChange={(e) => setPlanDate(e.target.value)}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={!!working}
                    onClick={() => void calculatePlan()}
                  >
                    {working === "plan" ? (
                      <LoaderCircle className="spinner" size={16} />
                    ) : (
                      <Compass size={16} />
                    )}{" "}
                    Calculate visibility
                  </button>
                </div>
                {plan && (
                  <>
                    <Suspense fallback={<div className="chart" />}>
                      <PlannerChart
                        data={plan.samples.map((p: Result) => ({
                          time: p.time.slice(11, 16),
                          altitude: p.altitude,
                          sun: p.sunAltitude,
                        }))}
                      />
                    </Suspense>
                    <div className="window-list">
                      {plan.windows.length ? (
                        plan.windows.map((w: Result, i: number) => (
                          <div key={i}>
                            <span className="signal-dot" />
                            <strong>
                              {w.start.slice(11, 16)}–{w.end.slice(11, 16)} UTC
                            </strong>
                            <span>
                              {w.durationMinutes} min · altitude ≥30° · Sun
                              ≤−18°
                            </span>
                          </div>
                        ))
                      ) : (
                        <Notice>
                          No qualifying dark-sky window at this location on this
                          UTC date.
                        </Notice>
                      )}
                    </div>
                  </>
                )}
                <Notice>
                  Calculated for a fixed ICRS position, without refraction,
                  weather, horizon obstructions, or object-motion prediction.
                  This is a visibility aid, not an orbit solution or guarantee
                  of detectability.
                </Notice>
              </section>
            )}
            {page === "methods" && <Methods />}
            {researchPage &&
              (warnings.length > 0 ||
                failures.length > 0 ||
                (search?.attempts?.length ?? 0) > 0) && (
                <details className="warnings">
                  <summary>
                    Data notes and retrieval details (
                    {warnings.length + failures.length})
                  </summary>
                  {search?.attempts?.map((a, i) => (
                    <p key={`lookup-${i}`}>
                      {a.service}
                      {a.collection ? ` / ${a.collection}` : ""} ·{" "}
                      {a.httpStatus
                        ? `HTTP ${a.httpStatus}`
                        : a.code.replaceAll("-", " ")}
                      {a.rows !== undefined ? ` · ${a.rows} metadata rows` : ""}
                    </p>
                  ))}
                  {[...new Set(warnings)].map((w, i) => (
                    <p key={i}>{w}</p>
                  ))}
                  {failures.map((w, i) => (
                    <p key={`f${i}`}>{w}</p>
                  ))}
                </details>
              )}
            <footer className="page-footer">
              {page === "home" ? (
                <>
                  <span>
                    <span className="signal-dot" /> REAL DATA. OPEN QUESTIONS.
                  </span>
                  <span>
                    NASA/IPAC IRSA · SPHEREx · Independent Space Apps project
                  </span>
                </>
              ) : (
                <span>Data: NASA/IPAC IRSA, SPHEREx DR1 and QR3</span>
              )}
              <a
                href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
                target="_blank"
                rel="noreferrer"
              >
                {page === "home" ? (
                  <>Explore the mission <ArrowUpRight size={12} /></>
                ) : (
                  "irsa.ipac.caltech.edu"
                )}
              </a>
            </footer>
          </main>
        </div>
      </div>
      {tutorialOpen && (
        <Suspense fallback={null}>
          <BeginnerTour onClose={closeTutorial} onNavigate={go} />
        </Suspense>
      )}
    </Tooltip.Provider>
  );
}
function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <p>{text}</p>
    </div>
  );
}
function ScientificResult({
  result,
  onInvestigate,
}: {
  result: Result;
  onInvestigate?: (peak: Result) => void;
}) {
  const candidates = result.candidates || result.search?.candidates || [];
  const rows = result.measurements || [];
  return (
    <div className="scientific-result">
      <div className="section-title">
        <h3>
          <Check size={17} /> Calculation returned
        </h3>
        <span className="tag">{result.kind || "Preliminary"}</span>
      </div>
      {result.message && <p>{result.message}</p>}
      {Array.isArray(result.searchSnr) && (
        <EvidenceMaps
          key={result.referenceMjd}
          analysis={{
            width: Number(result.width),
            height: Number(result.height),
            stack: result.stack,
            difference: result.difference,
            searchSnr: result.searchSnr,
            candidates: result.candidates,
          }}
          onPeak={onInvestigate}
        />
      )}
      {result.selectedFrameIndices && (
        <p className="caption">
          {result.selectedFrameIndices.length} wavelength-compatible exposures ·{" "}
          {fmt(result.baselineDays)} days ·{" "}
          {result.excludedFrameIndices?.length || 0} excluded
        </p>
      )}
      {result.recovered && (
        <div className="recovery-grid">
          {[
            ["Shift and stack", "shiftStack"],
            ["Stationary stack", "staticStack"],
            ["Best single frame", "bestSingleFrame"],
          ].map(([label, k]) => (
            <div key={k}>
              <strong>
                {result.recovered[k]}/{result.trials}
              </strong>
              <span>{label}</span>
            </div>
          ))}
          <div>
            <strong>
              {result.unInjectedControlPeaks} / {result.negativeControlPeaks}
            </strong>
            <span>
              Control peaks, capped at {result.controlPeakCountCappedAt}
            </span>
          </div>
        </div>
      )}
      {result.recovered && (
        <div
          className="recovery-bars"
          aria-label="Measured synthetic source recovery by method"
        >
          {(
            [
              ["Shift and stack", "shiftStack"],
              ["Stationary stack", "staticStack"],
              ["Single frame", "bestSingleFrame"],
            ] as const
          ).map(([label, key]) => (
            <div key={key}>
              <span>{label}</span>
              <div className="recovery-bar-track">
                <div
                  style={{
                    width: `${100 * Number(result.recoveryFraction?.[key] ?? 0)}%`,
                  }}
                />
              </div>
              <strong>
                {result.recovered[key]} / {result.trials}
              </strong>
            </div>
          ))}
        </div>
      )}
      {(result.notes || result.warnings || result.limitations || []).map(
        (w: string, i: number) => (
          <p className="caption" key={i}>
            {w}
          </p>
        ),
      )}
      {candidates.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Nominal S/N</th>
                <th>Static S/N</th>
                <th>ICRS RA / Dec</th>
                <th>Trial motion</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {candidates.slice(0, 20).map((c: Result, i: number) => (
                <tr key={i}>
                  <td>
                    {onInvestigate ? (
                      <button
                        className="inline-link"
                        onClick={() => onInvestigate(c)}
                      >
                        Inspect peak {i + 1} <ArrowRight size={13} />
                      </button>
                    ) : (
                      `STX-${String(i + 1).padStart(3, "0")}`
                    )}
                  </td>
                  <td>{fmt(c.nominalSnr)}</td>
                  <td>{fmt(c.staticSnr)}</td>
                  <td>
                    {fmt(c.ra, 6)}° / {fmt(c.dec, 6)}°
                  </td>
                  <td>
                    {fmt(c.velocityWestArcsecDay, 3)},{" "}
                    {fmt(c.velocitySouthArcsecDay, 3)} ″/d
                  </td>
                  <td>
                    {c.velocityWestArcsecDay || c.velocitySouthArcsecDay
                      ? "Motion trial peak"
                      : "Stationary trial peak"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {Object.keys(rows[0])
                  .filter((k) => typeof rows[0][k] !== "object")
                  .slice(0, 8)
                  .map((k) => (
                    <th key={k}>{k.replaceAll("_", " ")}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 36).map((r: Result, i: number) => (
                <tr key={i}>
                  {Object.entries(r)
                    .filter(([, v]) => typeof v !== "object")
                    .slice(0, 8)
                    .map(([k, v]) => (
                      <td key={k}>
                        {typeof v === "number" ? fmt(v, 3) : String(v)}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="raw-result">
        <summary>Full measured results and parameters</summary>
        <pre>
          {JSON.stringify(
            result,
            (_k, v) =>
              Array.isArray(v) && v.length > 200
                ? `[${v.length} values — full array in export]`
                : v,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
function Methods() {
  return (
    <div className="methods-grid">
      <section className="panel tool-panel">
        <span className="eyebrow">THE SCIENTIFIC CONTRACT</span>
        <h2>Inspect. Compare. Question.</h2>
        <p>
          Every displayed observation comes from NASA/IPAC IRSA SPHEREx Level 2
          data. Search covers DR1 and QR3. If a stored archive index is used
          during an outage, the response identifies it. Retrieval errors are
          shown; an empty result is not replaced with a synthetic sky.
        </p>
        <h3>What the viewer does</h3>
        <p>
          Reads IMAGE, VARIANCE, FLAGS, and available ZODI and WCS-WAVE
          extensions. Reprojects images to a common celestial grid, excludes
          selected bad-pixel flags, subtracts the supplied zodiacal-light model
          when available, and applies a display-only stretch.
        </p>
        <h3>What a difference means</h3>
        <p>
          Same detector does not mean same wavelength. Optical response,
          background, flags, sampling and wavelength can change between visits.
          A difference is exploratory until those explanations are tested.
          Reprojection correlates noise; nominal errors do not include all
          systematics.
        </p>
        <h3>Search and experiments</h3>
        <p>
          DeepTrace is an experimental numerical search, not a trained discovery
          classifier. It compares trial motion stacks with a stationary stack.
          The laboratory adds labeled synthetic sources to real backgrounds and
          reports measured recovery and controls. No population-wide performance
          or Planet X discovery is claimed.
        </p>
        <h3>What remains research work</h3>
        <p>
          Calibrated 102-channel source spectra, detector ePSF fitting,
          validated machine-learning artifact classification, full catalog
          verification, orbit fitting, blind survey benchmarking, and shared
          citizen-science review require further development. The tool does not
          label an unmatched residual a new astronomical object.
        </p>
      </section>
      <section className="panel tool-panel">
        <span className="eyebrow">DATA, METHODS & CREDIT</span>
        <h2>Follow the source.</h2>
        {[
          [
            "SPHEREx at NASA/IPAC IRSA",
            "https://irsa.ipac.caltech.edu/Missions/spherex.html",
          ],
          [
            "Data access: DR1 + QR3",
            "https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-access/",
          ],
          [
            "Data products and calibration",
            "https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-products/",
          ],
          [
            "Official tutorial notebooks",
            "https://caltech-ipac.github.io/irsa-tutorials/spherex/",
          ],
          [
            "JPL Horizons — independent follow-up",
            "https://ssd.jpl.nasa.gov/horizons/",
          ],
          [
            "Gaia DR3 archive",
            "https://archive.stsci.edu/missions-and-data/gaia",
          ],
          ["Source code & reproducibility", "/source.zip"],
        ].map(([label, url]) => (
          <a
            key={url}
            className="resource-link"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {label}
            <ArrowUpRight size={15} />
          </a>
        ))}
        <h3>Built with open research</h3>
        <p>
          Reference projects:{" "}
          <a href="https://github.com/Nsa-2026/skyshift">SkyShift</a>{" "}
          (Apache-2.0) and{" "}
          <a href="https://github.com/epsretriever/spherex-planet-x">
            Driftnet
          </a>{" "}
          (MIT). Reuse and modifications are documented in the repository.
          Development used AI assistance; calculations run in inspectable code.
        </p>
        <p className="caption">
          SPHEREx is a joint project of JPL and Caltech, funded by NASA. This
          independent challenge project is not endorsed by NASA. Mission data
          and their calibration limitations remain the basis of every
          investigation.
        </p>
      </section>
    </div>
  );
}
