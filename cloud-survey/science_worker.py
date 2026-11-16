"""Kaggle survey adapter for the existing SPHEREx and DeepTrace pipelines.

No pixels leave the worker. A preprocessed product retains a native-file SHA-256,
and motion search requests byte ranges conditional on the same S3 object ETag.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import asdict
import hashlib
import io
import math
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

import numpy as np
import requests
from astropy.io import fits
from astropy.io.fits.verify import VerifyError

from science import archive, bulk_catalog, catalogs, survey, survey_image, survey_motion


ALGORITHM = "slowtrace-deeptrace-cloud/1"
MAX_PRODUCT_BYTES = survey_image.MAX_DOWNLOAD_BYTES
MAX_PLANNER_RECORDS = 512
MAX_GROUPS = 24
IMAGE_HEADERS = ("IMAGE", "VARIANCE", "FLAGS", "ZODI")
PAGE_BYTES = 256 * 1024
MAX_CACHED_PAGES = 8
MAX_RANGE_BYTES = 48 * 1024 * 1024
WAVELENGTH_NOTE = (
    "Spectral screening uses the approximate FITS WCS-WAVE calibration. "
    "Precise wavelengths require the separately published Spectral WCS calibration files."
)
REQUEST_TIMEOUT = (8, 25)


class ProductLimit(RuntimeError):
    """The product exceeds this worker's bounds and has not been processed."""


def _etag(value):
    token = str(value or "").strip().strip('"')
    if not token or not all(c in "0123456789abcdefABCDEF-" for c in token):
        return None
    return f'"{token}"'


def _verify_native(hdul, product):
    if not hdul[0].header.get("SIMPLE") or hdul[0].header.get("NAXIS") != 0:
        raise survey_image.ImageRejected("Expected a SPHEREx multi-extension FITS image.")
    header = hdul["IMAGE"].header
    if str(header["OBSID"]).strip() + f"D{header['DETECTOR']}" != product.id:
        raise survey_image.ImageRejected("The FITS exposure identity differs from the NASA object path.")
    width, height = int(header["NAXIS1"]), int(header["NAXIS2"])
    if min(width, height) < 32 or max(width, height) > 4096:
        raise ProductLimit("Native image dimensions exceed the worker's supported bounds.")
    for name in IMAGE_HEADERS:
        if name == "ZODI" and name not in hdul:
            continue
        ext = hdul[name].header
        if (ext["NAXIS"], ext["NAXIS1"], ext["NAXIS2"]) != (2, width, height):
            raise survey_image.ImageRejected(f"The {name} extension has inconsistent native dimensions.")
    if "WCS-WAVE" in hdul:
        wave = hdul["WCS-WAVE"].header
        table_size = int(wave["NAXIS1"]) * int(wave["NAXIS2"]) + int(wave.get("PCOUNT", 0))
        if not 0 < table_size <= 2 * 1024 * 1024:
            raise ProductLimit("The FITS spectral calibration table is outside the supported bounds.")
    return header


def _measure_wavelength(hdul, header):
    if "WCS-WAVE" not in hdul:
        return {}
    table = hdul["WCS-WAVE"].data
    wavelength = np.asarray(table["VALUES"][0], dtype=float)[..., int(header.get("PV1_3W", 1)) - 1]
    x, y = (np.asarray(table[name][0], dtype=float) for name in ("X", "Y"))
    if (wavelength.shape != (len(y), len(x)) or min(len(x), len(y)) < 2
            or not np.all(np.diff(x) > 0) or not np.all(np.diff(y) > 0)
            or not np.all(np.isfinite(wavelength)) or not np.all(wavelength > 0)):
        raise survey_image.ImageRejected("Invalid FITS wavelength lookup table.")
    bounds = [float(wavelength.min()), float(wavelength.max())]
    if wavelength.size <= 64:
        header_keys = (f"{name}{axis}W" for axis in (1, 2) for name in ("CRVAL", "CRPIX", "CDELT"))
        grid = dict(x=x.tolist(), y=y.tolist(), values=np.round(wavelength, 6).tolist(),
                    header={key: header[key] for key in header_keys if key in header})
    else:
        # A compact grid is only used to plan groups. Exact patch values from the
        # archived table are checked again when each projected image is loaded.
        gx = np.linspace(0, header["NAXIS1"] - 1, 5)
        gy = np.linspace(0, header["NAXIS2"] - 1, 5)
        xx, yy = np.meshgrid(gx, gy)
        mesh = archive.wavelength_map(header, table, xx, yy)
        grid = dict(x=(gx + 1).tolist(), y=(gy + 1).tolist(),
                    values=np.round(mesh, 6).tolist(), header={})
    return dict(wavelengthBoundsUm=bounds, wavelengthGrid=grid,
                wavelengthSource="FITS WCS-WAVE; approximate")


def _download(url, destination, limits, declared, expected_etag):
    digest = hashlib.sha256()
    count = 0
    headers = {"Accept-Encoding": "identity", "User-Agent": "SLOWTRACE-X/4 SPHEREx survey"}
    if expected_etag:
        headers["If-Match"] = expected_etag
    with requests.get(url, headers=headers, stream=True, allow_redirects=False,
                      timeout=REQUEST_TIMEOUT) as response:
        response.raise_for_status()
        if response.status_code != 200 or "Content-Range" in response.headers:
            raise requests.RequestException("Expected the complete public NASA FITS object.")
        length = response.headers.get("Content-Length", "")
        if not length.isdecimal() or (declared is not None and int(length) != declared):
            raise requests.RequestException("NASA object size could not be verified against the listing.")
        length = int(length)
        if not 0 < length <= MAX_PRODUCT_BYTES:
            raise ProductLimit("The listed FITS object exceeds the full-product byte limit.")
        version = _etag(response.headers.get("ETag"))
        if version is None or (expected_etag is not None and version != expected_etag):
            raise requests.RequestException("The NASA object ETag changed or was unavailable.")
        limits.check(additional_scratch_bytes=length)
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            count += len(chunk)
            limits.transferred(len(chunk))
            if count > length:
                raise requests.RequestException("The FITS transfer exceeded its declared size.")
            limits.check(additional_scratch_bytes=len(chunk))
            destination.write(chunk)
            digest.update(chunk)
    if count != length:
        raise requests.RequestException("The FITS transfer ended before its declared size.")
    return count, digest.hexdigest(), version


def load_product(product, limits):
    """Preprocess one verified native product under the caller's resource limits."""
    metadata = product.get("metadata", product)
    url = metadata.get("cloudUrl") or metadata.get("url") or metadata.get("sourceUrl")
    size = metadata.get("sizeBytes") or metadata.get("size") or metadata.get("downloadedBytes")
    size = int(size) if size is not None else None
    if size is not None and not 0 < size <= MAX_PRODUCT_BYTES:
        raise ProductLimit("The listed FITS object exceeds the full-product byte limit.")
    native = bulk_catalog.product(url, size, metadata.get("etag"))
    if product.get("observation_id") not in (None, native.id):
        raise survey_image.ImageRejected("The database observation identity differs from the NASA path.")
    limits.check(additional_scratch_bytes=size or MAX_PRODUCT_BYTES)
    with tempfile.TemporaryDirectory(prefix="frame-", dir=limits.scratch) as temporary:
        path = Path(temporary) / "exposure.fits"
        with path.open("wb") as destination:
            count, digest, etag = _download(native.url, destination, limits, size, _etag(native.etag))
        limits.check()
        try:
            with fits.open(path, memmap=False, lazy_load_hdus=True) as hdul:
                header = _verify_native(hdul, native)
                measures = survey_image._measure(hdul, native.id.removesuffix(f"D{native.detector}"), native.detector)
                measures.update(_measure_wavelength(hdul, header))
        except (OSError, ValueError, KeyError, IndexError, TypeError, OverflowError, VerifyError) as error:
            if isinstance(error, survey_image.ImageRejected):
                raise
            raise survey_image.ImageRejected(f"Native FITS science measurements failed: {error}") from error
    # Keep individual coverage estimates compact. These cannot be summed to
    # infer union coverage because detector images repeatedly cover the same sky.
    ranges = measures.pop("coverageRanges")
    measures["usableSampleCells"] = sum(end - start for start, end in ranges)
    path = urlsplit(native.url).path
    release, _, _, version, *_ = path.lstrip("/").split("/")
    return dict(id=native.id, detector=native.detector, release=release, version=version,
                collection=f"spherex_{release}", cloudUrl=native.url,
                sourceUrl=f"https://irsa.ipac.caltech.edu/ibe/data/spherex{path}",
                sha256=digest, downloadedBytes=count, etag=etag, processedAt=archive.now(),
                pipelineVersion=survey_image.VERSION, **measures)


def _planner_source(row):
    record = row.get("metadata", row)
    source = survey_motion._prepare_source(record)
    native = bulk_catalog.product(source["url"])
    source.update(rank=native.rank, productId=row["id"], etag=record["etag"],
                  size=record["downloadedBytes"], zodiSubtracted=record["zodiSubtracted"])
    return source


def _field_sources(sources, ra, dec, config):
    grid, _ = archive.target_grid(ra, dec, config.fov, 32)
    sky = grid.all_pix2world([-.5, -.5, 31.5, 31.5, 15.5], [-.5, 31.5, -.5, 31.5, 15.5], 0)
    covered = []
    for source in sources:
        inside, x, y = survey_motion._within_visit(source, sky)
        if not inside:
            continue
        wave = survey_motion._patch_wavelength(source["wavelengthGrid"], x, y)
        if wave is not None:
            covered.append({**source, "patchWavelengthUm": wave})
    best = []
    for found_model in (False, True):
        selected = survey_motion._select([s for s in covered if s["zodiSubtracted"] == found_model], config)
        if len(selected) > len(best):
            best = selected
    return best


def plan_groups(records, ra=None, dec=None, detector=None, fov=5, max_groups=12):
    """Find bounded multi-epoch fields from already preprocessed native images."""
    if (ra is None) != (dec is None) or (detector is not None and not 1 <= detector <= 6):
        raise ValueError("Supply both sky coordinates and a supported detector, or omit the detector for automatic selection.")
    if ra is not None:
        archive.checked_position(ra, dec, fov)
    by_observation = {}
    for index, row in enumerate(records):
        if index >= MAX_PLANNER_RECORDS:
            raise ValueError("The planner accepts up to 512 neighboring preprocessed products per pass.")
        if row.get("state", "preprocessed") != "preprocessed":
            continue
        source = _planner_source(row)
        prior = by_observation.get(source["id"])
        if prior is None or (source["rank"], source["sha256"]) > (prior["rank"], prior["sha256"]):
            by_observation[source["id"]] = source
    by_detector = {}
    for source in by_observation.values():
        if (source["fineAstrometryFlag"] in (None, 0, "0") and source["wavelengthGrid"] is not None
                and (detector is None or detector == source["detector"])):
            by_detector.setdefault(source["detector"], []).append(source)
    limit = max(0, min(MAX_GROUPS, int(max_groups)))
    if limit == 0:
        return []
    groups = []
    for det, sources in sorted(by_detector.items()):
        config = survey.SurveyConfig(detector=det, fov=fov)
        if len(sources) < config.min_epochs:
            continue
        sources.sort(key=lambda source: (source["mjd"], source["id"]))
        if ra is not None:
            anchors = [(ra, dec, "Requested field", 0)]
        else:
            distinct = set()
            for source in sources:
                _, radius = survey_motion._bound(source)
                distinct.update(survey_motion._anchors(source, radius, survey_motion.MESH_DEG))
            anchors = sorted(distinct, key=lambda item: (item[3], item[1], item[0]))
        for lon, lat, label, _ in anchors:
            selected = _field_sources(sources, lon, lat, config)
            if len(selected) < config.min_epochs:
                continue
            inputs = [{key: s[key] for key in ("id", "url", "collection", "detector", "mjd", "sha256", "etag",
                                               "size", "productId", "metadataSource", "metadataRetrievedAt")}
                      for s in selected]
            parameters = asdict(config)
            fingerprint = survey.identifier("cg-", [ALGORITHM, lon, lat, parameters,
                                                       [[s["productId"], s["sha256"]] for s in inputs]])
            groups.append(dict(id=fingerprint, algorithm=ALGORITHM,
                               product_ids=[s["productId"] for s in inputs],
                               metadata=dict(field=dict(ra=lon, dec=lat, label=label, fov=fov, detector=det),
                                             parameters=parameters, inputs=inputs)))
            if ra is None and len(groups) >= limit:
                return groups
    groups.sort(key=lambda group: (-len(group["product_ids"]), group["id"]))
    return groups[:limit]


class _PublicRanges(io.RawIOBase):
    """Small seekable S3 reader with conditional GET, byte accounting and a hard cap."""

    def __init__(self, native, limits):
        self.url = archive.cloud_url(native["url"])
        self.size = int(native["size"])
        self.etag = _etag(native["etag"])
        if self.etag is None or not 0 < self.size <= MAX_PRODUCT_BYTES:
            raise ValueError("A verified native size and S3 ETag are required for motion analysis.")
        self.limits = limits
        self.position = 0
        self.byte_count = 0
        self.pages = OrderedDict()
        self.session = requests.Session()

    def seekable(self):
        return True

    def readable(self):
        return True

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.size}[whence]
        if base + offset < 0:
            raise ValueError("Negative FITS seek offset.")
        self.position = base + offset
        return self.position

    def tell(self):
        return self.position

    def close(self):
        if not self.closed:
            if hasattr(self, "session"):
                self.session.close()
                self.pages.clear()
        super().close()

    def _page(self, start):
        if start in self.pages:
            self.pages.move_to_end(start)
            return self.pages[start]
        self.limits.check()
        stop = min(start + PAGE_BYTES, self.size) - 1
        expected = stop - start + 1
        if self.byte_count + expected > MAX_RANGE_BYTES:
            raise ProductLimit("The cutout would exceed the per-product NASA range-read cap.")
        headers = {"Range": f"bytes={start}-{stop}", "If-Match": self.etag, "Accept-Encoding": "identity",
                   "User-Agent": "SLOWTRACE-X/4 SPHEREx motion survey"}
        buffer = bytearray()
        with self.session.get(self.url, headers=headers, stream=True, allow_redirects=False,
                              timeout=REQUEST_TIMEOUT) as response:
            response.raise_for_status()
            if (response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{stop}/{self.size}"
                    or _etag(response.headers.get("ETag")) != self.etag):
                raise requests.RequestException("NASA did not return the exact selected FITS byte range.")
            for chunk in response.iter_content(chunk_size=64 * 1024):
                self.limits.transferred(len(chunk))
                self.byte_count += len(chunk)
                if len(buffer) + len(chunk) > expected:
                    raise requests.RequestException("A FITS range transfer exceeded its declared length.")
                buffer.extend(chunk)
        if len(buffer) != expected:
            raise requests.RequestException("A FITS range transfer was incomplete.")
        if len(self.pages) == MAX_CACHED_PAGES:
            self.pages.popitem(last=False)
        self.pages[start] = bytes(buffer)
        return self.pages[start]

    def read(self, size=-1):
        remaining = max(0, self.size - self.position)
        count = remaining if size is None or size < 0 else min(size, remaining)
        if count > MAX_RANGE_BYTES:
            raise ProductLimit("The FITS reader requested a read beyond the per-product range cap.")
        result = bytearray()
        while len(result) < count:
            start = self.position // PAGE_BYTES * PAGE_BYTES
            offset = self.position - start
            block = self._page(start)
            data = block[offset:offset + count - len(result)]
            result.extend(data)
            self.position += len(data)
        return bytes(result)

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


def _load_patch(source, ra, dec, fov, pixels, limits):
    native = bulk_catalog.product(source["url"])
    if native.id != source["id"] or native.detector != source["detector"]:
        raise ValueError("The stored motion input does not match the authoritative SPHEREx product path.")
    with _PublicRanges(source, limits) as raw:
        with fits.open(raw, mode="readonly", memmap=False, lazy_load_hdus=True) as hdul:
            header = _verify_native(hdul, native)
            if header.get("FINAST") not in (None, 0, "0"):
                raise survey_image.ImageRejected("SPHEREx flagged this exposure's fine astrometry.")
            frame = archive._process_frame(hdul, source["url"], ra, dec, fov, pixels, None, None,
                                           "NASA S3 conditional byte-range reads", [WAVELENGTH_NOTE])
        frame["provenance"].update(nativeSourceSha256AtSelection=source["sha256"], sourceETag=raw.etag,
                                   nasaFitsBytesTransferred=raw.byte_count)
    return frame


def _review(candidates, limits):
    if not candidates:
        return
    limits.check()
    first = max(candidates, key=lambda item: item["evidence"]["snrGainOverStatic"])
    try:
        review = catalogs.investigate(first)
    except (OSError, ValueError, RuntimeError) as error:
        review = dict(status="failed", checkedAt=archive.now(), error=str(error)[:350])
    first["evidence"]["catalogReview"] = review
    # These measurements are predicted trial positions. The catalog engine may
    # report preliminary associations but the worker cannot confirm objects.


def search_group(group, limits, catalog_checks=0):
    """Run the existing DeepTrace engine on the exact preselected native products."""
    metadata = group["metadata"]
    config = survey.SurveyConfig(**metadata["parameters"])
    field = {**metadata["field"], "id": group["id"]}
    sources = {source["url"]: source for source in metadata["inputs"]}
    if len(sources) != len(group["product_ids"]) or not config.min_epochs <= len(sources) <= config.observations:
        raise ValueError("A motion group must contain three to eight distinct verified SPHEREx products.")
    frames = {}
    frame_errors = {}
    rate_limit = None

    def exact_inputs(*_):
        return {"status": "verified-image-selection", "totalAvailable": None, "observations": list(sources.values()),
                "searchCoverage": {"complete": False}, "truncated": True,
                "warnings": ["Only this bounded group of native products was tested. Other epochs may exist.",
                             WAVELENGTH_NOTE]}

    def fetch(url, ra, dec, fov, pixels):
        nonlocal rate_limit
        if rate_limit is not None:
            raise rate_limit
        try:
            frame = _load_patch(sources[url], ra, dec, fov, pixels, limits)
        except requests.HTTPError as error:
            status = error.response.status_code if error.response is not None else None
            frame_errors[url] = f"NASA S3 returned HTTP {status}."
            if status in (429, 503):
                rate_limit = error
            raise
        except (archive.ArchiveError, ProductLimit, survey_image.ImageRejected) as error:
            frame_errors[url] = str(error)[:350]
            raise
        frames[url] = frame
        return frame

    limits.check()
    report, analysis, detections = survey.process_field(field, config, search=exact_inputs, fetch=fetch, fetch_workers=1)
    if rate_limit is not None:
        raise rate_limit
    limits.check()
    for failure in report["frameFailures"]:
        if detail := frame_errors.get(failure["url"]):
            failure["detail"] = detail
    if analysis is not None:
        coverage = survey_motion.common_coverage(field["ra"], field["dec"], config,
                                                [frames[s["url"]] for s in analysis["observations"]])
        area = survey_motion.MOTION_CELL_DEG2 * sum(end - start for start, end in coverage)
        native_ids = [sources[s["url"]]["productId"] for s in analysis["observations"]]
        analysis.update(motionAreaDeg2=area, retainedNativeProductIds=native_ids, algorithm=ALGORITHM,
                        motionAreaMethod="HEALPix estimate of common quality-masked pixels in the selected patch.")
        report.update(motionAreaDeg2=area, observations=[])
        if not report["frameFailures"]:
            report["status"] = "complete"
            report["message"] = (f"Searched {report['observationsAnalyzed']} comparable epochs in this group. "
                                 f"Retained {len(detections)} motion-trial peaks for review.")
    if catalog_checks:
        _review(detections, limits)
    candidates = []
    for candidate in detections:
        evidence = dict(candidate["evidence"], referenceMjd=candidate["referenceMjd"],
                        field=candidate["field"], analysisId=candidate["analysisId"],
                        analysisPixels=candidate["analysisPixels"], observations=candidate["observations"],
                        history=candidate["history"])
        candidates.append({**{key: candidate[key] for key in ("id", "ra", "dec")},
                           "classification": "insufficient", "evidence": evidence})
    return dict(report=report, analysis=analysis, candidates=candidates)
