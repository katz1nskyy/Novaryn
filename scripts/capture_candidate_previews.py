"""Build candidate gallery previews from exact NASA FITS exposures in the survey.

Install Pillow locally to regenerate the display images. The capture uses the
same calibrated, masked and WCS-aligned pixels as the observation desk.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from science import archive


def frame_image(frame):
    pixels = np.asarray(frame["data"], dtype=float).reshape(frame["height"], frame["width"])
    valid = np.isfinite(pixels)
    low, high = np.quantile(pixels[valid], [0.02, 0.995])
    normalized = np.clip((pixels[valid] - low) / (high - low or 1), 0, 1)
    gray = np.zeros(pixels.shape, dtype=np.uint8)
    gray[valid] = 15 + 240 * np.arcsinh(normalized * 12) / np.arcsinh(12)
    buf = io.BytesIO()
    Image.fromarray(gray).save(buf, format="WEBP", lossless=True)
    return {
        "image": "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii"),
        "stretch": {"low": float(low), "high": float(high), "unit": frame["metadata"]["unit"]},
    }


def select_preview(candidate):
    field = candidate.get("field")
    if not field:
        return None
    size = candidate.get("analysisPixels") or 96
    observations = sorted(
        candidate["observations"],
        key=lambda item: (
            abs(item["mjd"] - candidate["referenceMjd"]),
            (item.get("quality") or {}).get("badFraction", 1),
        ),
    )
    context_preview = None
    for observation in observations:
        try:
            frame = archive.frame(observation["url"], field["ra"], field["dec"], field["fov"], size)
            metadata, provenance = frame["metadata"], frame["provenance"]
            if (
                provenance["sourceUrl"] != observation["url"]
                or metadata["detector"] != field["detector"]
                or abs(metadata["mjd"] - observation["mjd"]) > 1e-6
                or frame["dataKind"] != "processed-observation"
            ):
                raise ValueError("Archived frame does not match the published source")
            preview = {
                **frame_image(frame),
                "field": field,
                "width": frame["width"],
                "height": frame["height"],
                "observationId": observation["id"],
                "sourceUrl": provenance["sourceUrl"],
                "processedSha256": provenance["processedSha256"],
                "matchesSurveyPixels": provenance["processedSha256"]
                == (observation.get("provenance") or {}).get("processedSha256"),
                "mjd": metadata["mjd"],
                "wavelengthUm": metadata["wavelengthCenter"],
                "badFraction": metadata["badFraction"],
                "retrievedAt": provenance["retrievedAt"],
            }
            if preview["matchesSurveyPixels"]:
                return preview
            if context_preview is None:
                context_preview = preview
        except (RuntimeError, ValueError, OSError) as error:
            print(f"{candidate['analysisId']}: {observation['id']} unavailable ({error})", flush=True)
    return context_preview


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=6, choices=range(1, 9))
    args = parser.parse_args()
    snapshot = json.loads((ROOT / "public" / "survey.json").read_text(encoding="utf-8"))
    analyses = {candidate["analysisId"]: candidate for candidate in snapshot["candidates"]}

    def capture(item):
        analysis_id, candidate = item
        preview = select_preview(candidate)
        if preview:
            print(f"{analysis_id}: captured {preview['observationId']}", flush=True)
        return analysis_id, preview

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        previews = {key: value for key, value in executor.map(capture, analyses.items()) if value}
    if not previews:
        raise SystemExit("No original frames were available. The preview index was left intact.")
    target = ROOT / "public" / "candidate-previews.json"
    target.write_text(json.dumps(previews, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"Captured {len(previews)} of {len(analyses)} candidate analysis previews.")


if __name__ == "__main__":
    main()
