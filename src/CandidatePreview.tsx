import { ExternalLink, Telescope } from "lucide-react";
import { date, fmt, skyPixel } from "./lib";
import type { Candidate } from "./surveyTypes";
import type { Query } from "./types";

interface PreviewFrame {
  image: string;
  field: Query;
  width: number;
  height: number;
  observationId: string;
  sourceUrl: string;
  matchesSurveyPixels: boolean;
  mjd: number;
  wavelengthUm: number | null;
  badFraction: number;
}

export type CandidatePreviews = Record<string, PreviewFrame>;

export default function CandidatePreview({
  candidate,
  previews,
  onDetails,
}: {
  candidate: Candidate;
  previews: CandidatePreviews | null | undefined;
  onDetails: () => void;
}) {
  const preview = previews?.[candidate.analysisId];
  if (
    !preview ||
    !candidate.observations.some(
      (observation) =>
        observation.id === preview.observationId &&
        observation.url === preview.sourceUrl &&
        Math.abs(observation.mjd - preview.mjd) < 1e-6,
    )
  ) {
    return (
      <div className="finding-preview-empty">
        <Telescope size={19} aria-hidden="true" />
        <span>
          {previews === undefined
            ? "Loading NASA preview…"
            : "No NASA preview available for this record."}
        </span>
        {previews !== undefined && (
          <button className="text-button" onClick={onDetails}>
            View observation records
          </button>
        )}
      </div>
    );
  }

  const epoch = candidate.evidence.epochMeasurements?.find(
    (sample) =>
      sample.observationId === preview.observationId &&
      sample.positionKind === "predicted-track",
  );
  const position = epoch
    ? skyPixel(
        epoch.ra,
        epoch.dec,
        preview.width,
        preview.height,
        preview.field,
      )
    : null;
  const x = position ? (position.x + 0.5) / preview.width : 0.5;
  const y = position ? (position.y + 0.5) / preview.height : 0.5;
  const span = position ? 0.55 : 1;
  const cropLeft = Math.max(0, Math.min(1 - span, x - span / 2));
  const cropTop = Math.max(0, Math.min(1 - span, y - span / 2));
  const observed = date(preview.mjd);

  return (
    <figure className="finding-preview">
      <div className="finding-preview-image">
        <img
          src={preview.image}
          alt={`NASA SPHEREx infrared observations from ${observed} at the candidate field`}
          loading="lazy"
          decoding="async"
          style={{
            width: `${100 / span}%`,
            height: `${100 / span}%`,
            left: `${(-100 * cropLeft) / span}%`,
            top: `${(-100 * cropTop) / span}%`,
          }}
        />
        {position && (
          <span
            className="finding-preview-ring"
            aria-hidden="true"
            style={{
              left: `${(100 * (x - cropLeft)) / span}%`,
              top: `${(100 * (y - cropTop)) / span}%`,
            }}
          />
        )}
      </div>
      <figcaption>
        <strong>Observed SPHEREx</strong>
        <time dateTime={observed}>{observed} UTC</time>
        <span>
          D{preview.field.detector} · {fmt(preview.wavelengthUm, 3)} µm
        </span>
        {position && <span>Ring marks the trial position</span>}
        <span>
          {fmt((1 - preview.badFraction) * 100, 0)}% usable in field cutout
        </span>
        {!preview.matchesSurveyPixels && (
          <span>Fresh processing of the same exposure</span>
        )}
        <a href={preview.sourceUrl} target="_blank" rel="noreferrer">
          Original FITS <ExternalLink size={11} aria-hidden="true" />
        </a>
      </figcaption>
    </figure>
  );
}
