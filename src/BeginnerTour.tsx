/* Guided spotlight and chapter navigation adapted from Driftnet's TourPanel and lib/tour.
 * Copyright (c) 2026 epsretriever. MIT notice: public/driftnet-tour-license.txt.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, X } from "lucide-react";
import { date, fmt, quantile, renderPixels, request } from "./lib";
import type { Frame } from "./types";
import "./beginner-tour.css";

type TourPage = "observe" | "survey" | "atlas" | "stats";
type Step = {
  chapter: string;
  title: string;
  caption: string;
  tip?: string;
  page?: TourPage;
  target?: string;
  demo?: boolean;
};

const steps: Step[] = [
  {
    chapter: "Welcome",
    title: "Read the infrared sky",
    caption:
      "Start with two images of the same part of the sky from NASA’s SPHEREx telescope. Then follow those images from observation to a candidate record and see how a possible detection is reviewed.",
    tip: "You can jump to any step or leave the tutorial at any time.",
  },
  {
    chapter: "Blink",
    title: "Compare the same sky on two dates",
    caption:
      "An epoch is the time an image was taken. Switch the dates in this WISE 0855 example. Both images have the same display stretch, so the same brightness maps to the same shade. Dark gaps mark pixels excluded by the quality mask.",
    tip: "Look for a point that shifts relative to nearby stars. Changes can also come from noise, brightness changes, or image alignment. This comparison alone can’t confirm motion.",
    page: "observe",
    target: '[aria-label="Blink player"] .ob-stage',
    demo: true,
  },
  {
    chapter: "Coordinates",
    title: "Choose a patch of sky",
    caption:
      "Right ascension (RA) and declination (Dec) work like longitude and latitude on the sky. Field of view sets how much sky fits in the image. Each detector covers a different range of infrared light.",
    tip: "Start with a named example, or enter RA and Dec, leave the detector on Auto, and select Search to check archive coverage.",
    page: "observe",
    target: ".ob-query",
  },
  {
    chapter: "Candidates",
    title: "Read a candidate card",
    caption:
      "Each card is a signal the search saved for review. The image previews are real SPHEREx cutouts when available. The trial-path diagram in a candidate’s details shows the motion the software tested, with a sample position for each observing time.",
    tip: "Open the candidate ID to see its observation dates, source files, quality flags, and investigation.",
    page: "survey",
    target: ".candidate-gallery .finding-card",
  },
  {
    chapter: "Signal",
    title: "Use the numbers to decide where to look",
    caption:
      "DeepTrace shifts and combines the images along a series of possible paths. Nominal S/N is the signal-to-noise ratio under that calculation. S/N gain compares the moving solution with a stationary one. Trial ″/day is the tested angular speed in arcseconds per day.",
    tip: "A higher score helps rank candidates. Many speeds are tested and the image processing can correlate noise, so the score does not give the chance that the source is real.",
    page: "survey",
    target: ".candidate-gallery .finding-card dl",
  },
  {
    chapter: "Catalogs",
    title: "Check the evidence before calling it a discovery",
    caption:
      "Catalog checks compare the candidate with known stars in Gaia and solar-system objects from NASA JPL. “Catalog checked” means there is a review on file. The result can still be incomplete, or the match may be inconclusive.",
    tip: "“Insufficient evidence” means further checks or observations are needed. “Review pending” means no catalog review is on file for the card.",
    page: "survey",
    target: ".candidate-gallery .finding-card-top",
  },
  {
    chapter: "Atlas",
    title: "Find where the observatory looked",
    caption:
      "The Sky Atlas uses the same RA and Dec as Observe. Drag the map or search a position, then open observations there. The layers let you distinguish the sky background, survey fields, and individual observation footprints.",
    tip: "A footprint is the area covered by an observation. Motion searches use compatible images of the same patch on different dates.",
    page: "atlas",
    target: ".sky-atlas-stage",
  },
  {
    chapter: "Statistics",
    title: "See the results and their limits",
    caption:
      "Statistics shows how many archive images were processed, how many regions were searched for motion, and how many signals remain under review. It also links to the processing ledger and the real test data.",
    tip: "The Experiment Lab tests recovery by adding labeled simulated signals to actual NASA image backgrounds.",
    page: "stats",
    target: ".bulk-survey-hero",
  },
];

function EpochDemo() {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [selected, setSelected] = useState(0);
  const [failed, setFailed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = frames[selected];
  const scale = useMemo<[number, number]>(() => {
    const values = frames
      .flatMap((epoch) => epoch.data)
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    return [quantile(values, 0.02), quantile(values, 0.995)];
  }, [frames]);

  useEffect(() => {
    const controller = new AbortController();
    request<{ frames: Frame[] }>("/examples/wise0855.json", {
      signal: controller.signal,
    })
      .then(({ frames: recorded }) => {
        if (recorded.length < 2) throw new Error("Insufficient observations");
        setFrames(recorded.slice(0, 2));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (canvas.current && frame)
      renderPixels(canvas.current, frame, 1, "ice", undefined, scale);
  }, [frame, scale]);

  if (!frame)
    return (
      <p role="status">
        {failed
          ? "The recorded example could not be loaded."
          : "Loading the NASA observations…"}
      </p>
    );

  return (
    <figure className="beginner-tour-example">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Recorded WISE 0855 sky cutout for ${date(frame.metadata.mjd)}`}
      />
      <figcaption>
        <div
          className="beginner-tour-epochs"
          role="group"
          aria-label="Example observation date"
        >
          {frames.map((observation, index) => (
            <button
              type="button"
              key={observation.provenance.sourceUrl}
              aria-pressed={selected === index}
              onClick={() => setSelected(index)}
            >
              {date(observation.metadata.mjd)}
            </button>
          ))}
        </div>
        <span>
          {fmt(frame.metadata.wavelengthCenter, 3)} µm · Detector{" "}
          {frame.metadata.detector}
        </span>
        <a href={frame.provenance.sourceUrl} target="_blank" rel="noreferrer">
          Original NASA FITS <ArrowUpRight size={12} />
        </a>
      </figcaption>
    </figure>
  );
}

type Highlight = { top: number; left: number; width: number; height: number };
const equalHighlight = (a: Highlight | null, b: Highlight | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height);

export default function BeginnerTour({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (page: TourPage) => void;
}) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Highlight | null>(null);
  const [placement, setPlacement] = useState<"br" | "bl" | "tr" | "tl">("br");
  const panel = useRef<HTMLDivElement>(null);
  const current = steps[index];

  function go(next: number) {
    if (next < 0 || next >= steps.length || next === index) return;
    const page = steps[next].page;
    if (page && !document.querySelector(`main.view-${page}`)) onNavigate(page);
    setSpot(null);
    setPlacement("br");
    setIndex(next);
  }

  useEffect(() => {
    const trigger = document.activeElement;
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [index]);

  useEffect(() => {
    if (!current.target || !current.page) return;
    const selector = `main.view-${current.page} ${current.target}`;
    const deadline = Date.now() + 6000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let element: HTMLElement | undefined;
    let scheduled = 0;
    let observer: ResizeObserver | undefined;
    const topInset = () =>
      Math.max(
        0,
        document
          .querySelector("header.navbar, header.mission-header")
          ?.getBoundingClientRect().bottom ?? 0,
      );

    function measure() {
      const elementBounds = element?.getBoundingClientRect();
      if (!elementBounds || !panel.current || !element?.isConnected) {
        setSpot(null);
        return;
      }
      const padding = 6;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const inset = topInset();
      const top = Math.max(inset + 2, Math.round(elementBounds.top - padding));
      const left = Math.max(4, Math.round(elementBounds.left - padding));
      const bottom = Math.min(
        h - 4,
        Math.round(elementBounds.bottom + padding),
      );
      const right = Math.min(w - 4, Math.round(elementBounds.right + padding));
      const next =
        bottom > top && right > left
          ? { top, left, width: right - left, height: bottom - top }
          : null;
      setSpot((before) => (equalHighlight(before, next) ? before : next));
      if (!next || w <= 720) return;

      // As in Driftnet, choose the corner that obscures the least of the highlighted feature.
      const { offsetWidth: pw, offsetHeight: ph } = panel.current;
      const gap = 16;
      const horizontal = w - pw - gap;
      const vertical = h - ph - gap;
      const corners = [
        ["br", horizontal, vertical],
        ["bl", gap, vertical],
        ["tr", horizontal, inset + gap],
        ["tl", gap, inset + gap],
      ] as const;
      function overlap(x: number, y: number) {
        return (
          Math.max(0, Math.min(x + pw, right) - Math.max(x, left)) *
          Math.max(0, Math.min(y + ph, bottom) - Math.max(y, top))
        );
      }
      const best = corners.reduce((a, b) =>
        overlap(b[1], b[2]) < overlap(a[1], a[2]) ? b : a,
      );
      setPlacement(best[0]);
    }

    function queueMeasure() {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(measure);
    }

    function find() {
      element = Array.from(
        document.querySelectorAll<HTMLElement>(selector),
      ).find((item) => item.getClientRects().length > 0);
      if (!element) {
        if (Date.now() < deadline) timeout = setTimeout(find, 120);
        return;
      }
      const target = element.getBoundingClientRect();
      const inset = topInset() + 20;
      const room = window.innerHeight - inset;
      const offset =
        window.innerWidth > 720 && target.height < room * 0.8
          ? inset + (room - target.height) / 2
          : inset;
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      window.scrollTo({
        top: Math.max(0, window.scrollY + target.top - offset),
        behavior: reduceMotion ? "instant" : "smooth",
      });
      observer = new ResizeObserver(queueMeasure);
      observer.observe(element);
      if (panel.current) observer.observe(panel.current);
      queueMeasure();
    }

    timeout = setTimeout(find, 0);
    window.addEventListener("scroll", queueMeasure, { passive: true });
    window.addEventListener("resize", queueMeasure);
    return () => {
      clearTimeout(timeout);
      cancelAnimationFrame(scheduled);
      observer?.disconnect();
      window.removeEventListener("scroll", queueMeasure);
      window.removeEventListener("resize", queueMeasure);
    };
  }, [current]);

  function arrows(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      go(index + (event.key === "ArrowRight" ? 1 : -1));
    }
  }

  const last = index === steps.length - 1;
  return (
    <>
      {index === 0 && <div className="beginner-tour-dim" aria-hidden="true" />}
      {spot && (
        <div className="beginner-tour-spot" aria-hidden="true" style={spot} />
      )}
      <div
        ref={panel}
        className="beginner-tour"
        data-place={index === 0 ? "center" : placement}
        role="dialog"
        aria-modal="false"
        aria-labelledby="beginner-tour-title"
        aria-describedby="beginner-tour-caption"
        tabIndex={-1}
        onKeyDown={arrows}
      >
        <header className="beginner-tour-header">
          <span>
            Tutorial · {index + 1} of {steps.length}
          </span>
          <button type="button" onClick={onClose} aria-label="Exit tutorial">
            <X size={18} />
          </button>
        </header>
        <nav className="beginner-tour-chapters" aria-label="Tutorial chapters">
          {steps.map((step, i) => (
            <button
              type="button"
              key={step.chapter}
              aria-current={i === index ? "step" : undefined}
              title={step.chapter}
              onClick={() => go(i)}
              aria-label={`Jump to ${step.chapter}`}
            />
          ))}
        </nav>
        <h2 id="beginner-tour-title">{current.title}</h2>
        <p id="beginner-tour-caption">{current.caption}</p>
        {current.demo && <EpochDemo />}
        {current.tip && <p className="beginner-tour-tip">{current.tip}</p>}
        <div className="beginner-tour-actions">
          {index > 0 && (
            <button type="button" onClick={() => go(index - 1)}>
              <ArrowLeft size={16} /> Back
            </button>
          )}
          {last ? (
            <button
              type="button"
              className="beginner-tour-next"
              onClick={onClose}
            >
              Finish
            </button>
          ) : (
            <button
              type="button"
              className="beginner-tour-next"
              onClick={() => go(index + 1)}
            >
              {index === 0 ? "Start the tour" : "Next"} <ArrowRight size={16} />
            </button>
          )}
        </div>
        {index === 0 && (
          <p className="beginner-tour-credit">
            Tutorial adapted from{" "}
            <a
              href="https://spherex-planet-x.vercel.app/about/"
              target="_blank"
              rel="noreferrer"
            >
              Driftnet
            </a>{" "}
            ·{" "}
            <a
              href="/driftnet-tour-license.txt"
              target="_blank"
              rel="noreferrer"
            >
              MIT license
            </a>
          </p>
        )}
      </div>
    </>
  );
}
