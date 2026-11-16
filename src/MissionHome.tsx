import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  Globe2,
  Radar,
  Telescope,
} from "lucide-react";
import SkyCanvas from "./SkyCanvas";
import TutorialButton from "./TutorialButton";
import { date, fmt, quantile, request } from "./lib";
import type { Frame } from "./types";
import type { SurveySnapshot } from "./surveyTypes";

type MissionDestination = "atlas" | "survey" | "stats";
const nasaMosaic =
  "https://www.jpl.nasa.gov/images/pia26600-spherexs-first-all-sky-map/";

export default function MissionHome({
  onNavigate,
  onExample,
  onTutorial,
  firstVisit,
}: {
  onNavigate: (page: MissionDestination) => void;
  onExample: (index: number) => void;
  onTutorial: () => void;
  firstVisit: boolean;
}) {
  const [survey, setSurvey] = useState<SurveySnapshot | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const cancellation = new AbortController();
    request<SurveySnapshot>("/survey.json", { signal: cancellation.signal })
      .then(setSurvey)
      .catch(() => {});
    request<{ frames: Frame[] }>("/examples/wise0855.json", {
      signal: cancellation.signal,
    })
      .then((data) => setFrames(data.frames))
      .catch(() => {});
    return () => cancellation.abort();
  }, []);
  const scale = useMemo<[number, number] | undefined>(() => {
    if (!frames.length) return;
    const values = frames.flatMap((frame) =>
      frame.data.filter((value): value is number => value !== null),
    );
    return [quantile(values, 0.02), quantile(values, 0.995)];
  }, [frames]);
  const frame = frames[active];
  const metrics = survey?.summary;
  return (
    <div className="mission-home">
      <section className="mission-hero" aria-labelledby="mission-title">
        <img
          className="mission-art"
          src="/mission/spherex-mosaic.webp"
          alt="Infrared mosaic of the Milky Way from NASA SPHEREx, shown in visible colors"
          fetchPriority="high"
        />
        <div className="mission-veil" />
        <div className="mission-hero-content">
          <p className="eyebrow">
            <span className="signal-dot" /> NASA SPHEREx · PUBLIC RESEARCH ATLAS
          </p>
          <h1 id="mission-title">
            The infrared sky,
            <br />
            <em>in motion.</em>
          </h1>
          <p>
            Explore the same sky across different dates, investigate faint trial
            signals, and follow each observation back to the NASA archive.
          </p>
          <div className="mission-actions">
            <TutorialButton onClick={onTutorial} firstVisit={firstVisit} />
            <button className="primary" onClick={() => onNavigate("atlas")}>
              <Globe2 size={18} /> Explore the sky <ArrowRight size={17} />
            </button>
            <button className="secondary" onClick={() => onExample(0)}>
              <Telescope size={16} /> Open observations
            </button>
          </div>
        </div>
        <a
          className="mission-credit"
          href={nasaMosaic}
          target="_blank"
          rel="noreferrer"
        >
          SPHEREx first all-sky mosaic · NASA/JPL-Caltech{" "}
          <ArrowUpRight size={13} />
        </a>
        <a className="mission-scroll" href="#mission-guide">
          Start with one field <ArrowDown size={13} />
        </a>
      </section>
      <section className="mission-ledger" aria-label="Published survey results">
        <div>
          <span className="eyebrow">
            <Radar size={14} /> PUBLISHED SURVEY
          </span>
          <strong>{survey?.label ?? "Survey records"}</strong>
          {survey && <small>Published {date(survey.generatedAt)}</small>}
        </div>
        <div>
          <strong>{metrics?.fieldsAnalyzed?.toLocaleString() ?? "—"}</strong>
          <span>Fields analyzed</span>
        </div>
        <div>
          <strong>
            {metrics?.uniqueExposuresAnalyzed?.toLocaleString() ?? "—"}
          </strong>
          <span>Distinct exposures</span>
        </div>
        <div>
          <strong>{metrics?.candidates?.toLocaleString() ?? "—"}</strong>
          <span>Trial peaks retained</span>
        </div>
        <button className="text-button" onClick={() => onNavigate("stats")}>
          <ChartNoAxesCombined size={17} /> View results{" "}
          <ArrowUpRight size={14} />
        </button>
      </section>
      <section
        className="mission-guide"
        id="mission-guide"
        aria-labelledby="mission-guide-title"
      >
        <div className="mission-guide-copy">
          <span className="eyebrow">GUIDED INVESTIGATION</span>
          <h2 id="mission-guide-title">One field. Two dates.</h2>
          <p>
            This field contains the infrared brown dwarf WISE 0855. Switch
            between the two observations and look for stable stars to orient
            yourself. A brightness change can come from wavelength, detector
            response, or a real change in the sky.
          </p>
          <ol>
            <li>Compare the dates at the same display stretch.</li>
            <li>Check the selected wavelength and quality flags.</li>
            <li>Open both source exposures and record what you notice.</li>
          </ol>
          <button className="secondary" onClick={() => onExample(2)}>
            Investigate WISE 0855 <ArrowRight size={16} />
          </button>
        </div>
        <div className="mission-demo">
          <SkyCanvas
            frame={frame}
            mode="blink"
            contrast={1}
            palette="ice"
            scale={scale}
            point={null}
            caption={
              <>
                <span className="signal-dot" /> NASA / SPHEREx · OBSERVED
                INFRARED LIGHT
              </>
            }
          />
          <div className="mission-demo-controls">
            {frames.map((item, index) => (
              <button
                key={item.provenance.sourceUrl}
                aria-pressed={index === active}
                onClick={() => setActive(index)}
              >
                <strong>{date(item.metadata.mjd)}</strong>
                <span>
                  {fmt(item.metadata.wavelengthCenter, 3)} µm · D
                  {item.metadata.detector}
                </span>
              </button>
            ))}
            {frame && (
              <a className="inline-link" href={frame.provenance.sourceUrl}>
                Original FITS <ArrowUpRight size={14} />
              </a>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
