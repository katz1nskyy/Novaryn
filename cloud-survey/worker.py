"""Resumable SPHEREx pilot and bounded survey entry point for Kaggle CPU notebooks."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timedelta, timezone
import io
from importlib.metadata import version as package_version
from itertools import zip_longest
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import sys
import tempfile
import time
from urllib.parse import urlsplit
from uuid import uuid4

# Apply before importing NumPy or anything that loads a native thread pool.
for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                 "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "BLIS_NUM_THREADS"):
    os.environ[variable] = "1"

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from science import archive, bulk_catalog
from science_worker import load_product, plan_groups, search_group

MIB = 1024 ** 2
LEASE_SECONDS = 300
PILOT_POSITION = (269.4462, 4.76883, 5, 1)
PREFIXES = [f"{release}/level2/" for release in ("dr1", "qr3")]


class Paused(Exception):
    """A run can stop safely and resume from the last committed transaction."""


class DatabaseError(RuntimeError):
    pass


class Database:
    def __init__(self, url, secret):
        url = url.rstrip("/")
        if not re.fullmatch(r"https://[a-z0-9]+\.supabase\.co", url):
            raise ValueError("Use the dedicated Supabase project's HTTPS URL.")
        if not secret.startswith("sb_secret_"):
            raise ValueError("Use the dedicated Supabase project's server secret key.")
        self.endpoint = f"{url}/rest/v1/rpc/"
        self.session = requests.Session()
        self.session.headers.update({"apikey": secret, "User-Agent": "SlowtraceX-Kaggle/1.0"})

    def call(self, operation, **payload):
        try:
            with self.session.post(self.endpoint + "slowtrace_worker_" + operation, json=payload,
                                   timeout=(8, 35), allow_redirects=False) as response:
                if response.status_code in (402, 429, 507):
                    raise Paused("Supabase refused additional quota usage.")
                if response.status_code >= 300:
                    raise DatabaseError(f"Checkpoint service returned HTTP {response.status_code} for {operation}.")
                return response.json()
        except (requests.RequestException, ValueError) as error:
            raise DatabaseError(f"Checkpoint service unavailable during {operation}.") from error


class Limits:
    def __init__(self, args, scratch, db, lease):
        self.scratch = scratch
        self.db = db
        self.lease = lease
        self.started = time.monotonic()
        self.cpu_started = time.process_time()
        self.deadline = self.started + args.minutes * 60
        self.scratch_bytes = args.scratch_mib * MIB
        self.transfer_limit = args.transfer_mib * MIB
        self.memory = args.ram_mib * MIB
        self.downloaded = 0
        self.peak_scratch = 0
        self.heartbeat = self.started
        self.processed = 0
        self.searched = 0

    def _scratch_usage(self):
        used = sum(path.stat().st_size for path in self.scratch.rglob("*") if path.is_file())
        self.peak_scratch = max(self.peak_scratch, used)
        return used

    def check(self, additional_scratch_bytes=0):
        now = time.monotonic()
        if now >= self.deadline:
            raise Paused("Session time budget reached.")
        if self.downloaded >= self.transfer_limit:
            raise Paused("Session data transfer budget reached.")
        if resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024 >= self.memory * 0.9:
            raise Paused("Worker reached its RAM safety threshold.")
        if (self._scratch_usage() + additional_scratch_bytes > self.scratch_bytes
                or shutil.disk_usage(self.scratch).free < additional_scratch_bytes + 128 * MIB):
            raise Paused("The next read cannot fit inside the scratch budget.")
        if now - self.heartbeat >= 35:
            if self.db.call("heartbeat", p_lease_id=self.lease, p_lease_seconds=LEASE_SECONDS) is not True:
                raise Paused("Worker lease expired.")
            self.heartbeat = now

    def transferred(self, count):
        self.downloaded += count
        if self.downloaded > self.transfer_limit:
            raise Paused("Session data transfer budget reached during a read.")

    def usage(self):
        self._scratch_usage()
        return dict(cpuSeconds=round(time.process_time() - self.cpu_started, 1),
                    elapsedSeconds=round(time.monotonic() - self.started, 1),
                    peakRamBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                    peakScratchBytes=self.peak_scratch, archiveBytes=self.downloaded,
                    productsThisRun=self.processed, groupsThisRun=self.searched,
                    numpy=package_version("numpy"), astropy=package_version("astropy"))


def product_record(product):
    path = urlsplit(product.url).path.split("/")
    release, version = path[1], path[4]
    return dict(id=f"{product.id}/{release}/{version}", observation_id=product.id, release=release,
                version=version, state="discovered", attempts=0,
                metadata=dict(url=product.url, size=product.size, etag=product.etag,
                              rank=product.rank, detector=product.detector))


def read_search(session, ra, dec, detector, limit, limits):
    """Discover exact positions through IRSA, retaining a time-spread capped sample."""
    sample = {}
    for collection in archive.COLLECTIONS:
        limits.check()
        params = [("COLLECTION", collection), ("COLLECTION", collection + "_deep"),
                  ("POS", f"CIRCLE {ra:.8f} {dec:.8f} 0.000277778"),
                  ("RESPONSEFORMAT", "CSV"), ("MAXREC", "6000")]
        with session.get(archive.SIA, params=params, timeout=(8, 30), allow_redirects=False,
                         stream=True) as response:
            if response.status_code == 429:
                raise Paused("IRSA rate limited this session.")
            if response.status_code != 200:
                raise ValueError(f"IRSA returned HTTP {response.status_code} for {collection}.")
            body = bytearray()
            for chunk in response.iter_content(64 * 1024):
                limits.transferred(len(chunk))
                if len(body) + len(chunk) > 16 * MIB:
                    raise ValueError("IRSA field metadata exceeded the bounded response size.")
                body.extend(chunk)
            table = csv.DictReader(io.StringIO(body.decode("utf-8-sig").lstrip("\r\n")))
            fields = {"obs_collection", "obs_id", "access_url", "energy_bandpassname", "t_min", "t_max"}
            if not fields.issubset(table.fieldnames or ()):
                raise ValueError("Unexpected IRSA metadata format.")
            rows = list(table)
            if len(rows) >= 6000:
                print(f"{collection} field metadata hit the row cap. The result is a partial sample.")
        matches = archive._normalize(rows)
        if rows and not matches:
            raise ValueError("IRSA returned rows without usable public Level 2 URLs.")
        for item in matches:
            if detector and detector != item["detector"]:
                continue
            record = product_record(bulk_catalog.product(item["url"]))
            info = record["metadata"]
            info.update(mjd=item["mjd"], footprint=item.get("footprint"))
            sample[record["id"]] = record
    # Keep same-detector visits available for motion. If no detector was selected,
    # prefer one with the broadest sampled baseline, then cycle through all six.
    pools = []
    for number in range(1, 7):
        rows = sorted((r for r in sample.values() if r["metadata"]["detector"] == number),
                      key=lambda r: r["metadata"]["mjd"])
        if rows:
            pools.append((rows[-1]["metadata"]["mjd"] - rows[0]["metadata"]["mjd"], rows))
    pools.sort(key=lambda pair: (-pair[0], -len(pair[1])))
    ordered = [list(bulk_catalog.spread(rows)) for _, rows in pools]
    selected = []
    for rows in zip_longest(*ordered):
        selected.extend(r for r in rows if r is not None)
        if len(selected) >= limit:
            break
    return selected[:limit]


def pilot_seeds():
    """Prioritize exact public inputs from an archived successful Barnard's Star analysis."""
    manifest = ROOT / "public" / "survey.json"
    if not manifest.is_file():
        return []
    document = json.loads(manifest.read_text(encoding="utf-8"))
    fields = {field["id"] for field in document["fields"]
              if abs(field["ra"] - PILOT_POSITION[0]) < 1e-5
              and abs(field["dec"] - PILOT_POSITION[1]) < 1e-5
              and field["detector"] == PILOT_POSITION[3] and field["status"] == "complete"}
    products = {}
    for analysis in document["analyses"]:
        if analysis["fieldId"] in fields:
            for item in analysis["observations"]:
                record = product_record(bulk_catalog.product(item["url"]))
                products[record["id"]] = record
    return list(products.values())


def inventory_page(session, checkpoint, page_size, limits):
    """Interleave releases and checkpoint the last committed lexical object key."""
    index = int(checkpoint.get("next_release", 0)) % len(PREFIXES)
    cursors = dict(checkpoint.get("archive_cursors", {}))
    prefix = PREFIXES[index]
    state = cursors.get(prefix, {})
    if state.get("done"):
        index = (index + 1) % len(PREFIXES)
        prefix = PREFIXES[index]
        state = cursors.get(prefix, {})
    if state.get("done"):
        refreshed = datetime.fromisoformat(checkpoint["inventory_end"])
        if datetime.now(timezone.utc) - refreshed < timedelta(days=7):
            return [], checkpoint
        cursors, state = {}, {}
    limits.check()
    try:
        _, entries, after, done = bulk_catalog.list_page(session, prefix, after=state.get("after"),
                                                        page_size=page_size)
    except requests.HTTPError as error:
        if error.response is not None and error.response.status_code == 429:
            raise Paused("Public SPHEREx inventory rate limited this session.") from error
        raise
    rows = [product_record(bulk_catalog.product(bulk_catalog.BUCKET + key, size, etag))
            for key, size, etag in entries if archive.OBSERVATION_NAME.search("/" + key)]
    cursors[prefix] = dict(after=after, done=done)
    updated = dict(checkpoint, archive_cursors=cursors, next_release=(index + 1) % len(PREFIXES))
    if all(cursors.get(key, {}).get("done") for key in PREFIXES):
        updated["inventory_end"] = datetime.now(timezone.utc).isoformat()
    return rows, updated


def retry(record, message, *, maximum=4):
    attempts = record.get("attempts", 0) + 1
    return dict(state="blocked" if attempts >= maximum else "retry", attempts=attempts,
                retry_at=(datetime.now(timezone.utc) + timedelta(minutes=15 * 2 ** attempts)).isoformat(),
                metadata={**record.get("metadata", {}), "last_error": message[:300]})


def due(record):
    timestamp = record.get("retry_at")
    return record.get("state") in ("discovered", "compatible", "retry") and (
        not timestamp or datetime.fromisoformat(timestamp) <= datetime.now(timezone.utc))


class Run:
    def __init__(self, args, db, claim, limits):
        self.args, self.db, self.limits = args, db, limits
        self.checkpoint = claim.get("checkpoint") or {}
        self.job = claim.get("job")
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "SlowtraceX-Kaggle/1.0"})
        self.session.hooks["response"].append(self.measure_listing)
        self.catalog_checks = 1

    def measure_listing(self, response, **_):
        if response.url.startswith(bulk_catalog.BUCKET + "?"):
            self.limits.transferred(len(response.content))
        return response

    def commit(self, *, checkpoint=None, products=(), groups=(), job=None):
        self.limits.check()
        groups = [{"state": "compatible", **group} for group in groups]
        payload = dict(p_lease_id=self.limits.lease, p_commit_id=str(uuid4()), p_checkpoint=checkpoint,
                       p_products=list(products), p_groups=list(groups), p_job=job,
                       p_usage=self.limits.usage())
        try:
            result = self.db.call("commit", **payload)
        except DatabaseError:
            # A lost HTTP response may follow a committed transaction. Keep the commit ID.
            self.limits.check()
            result = self.db.call("commit", **payload)
        if not result or not result.get("ok"):
            raise Paused("The database stopped accepting commits. Check its storage and quota.")
        if checkpoint is not None:
            self.checkpoint = checkpoint

    def lookup(self, ids):
        if not ids:
            return []
        return self.db.call("lookup", p_ids=ids)

    def preprocess(self, record):
        self.limits.check()
        columns = {k: v for k, v in record.items()
                   if k in {"id", "observation_id", "release", "version", "metadata", "attempts"}}
        try:
            measurements = load_product(record, self.limits)
        except (requests.RequestException, ValueError, OSError, RuntimeError) as error:
            if isinstance(error, DatabaseError):
                raise
            if isinstance(error, requests.HTTPError) and error.response is not None and error.response.status_code in (429, 503):
                raise Paused("NASA archive throttled this session or is unavailable.") from error
            self.commit(products=[{**columns, **retry(record, str(error))}])
            return None
        result = dict(columns, state="preprocessed", retry_at=None,
                      metadata={**record["metadata"], **measurements})
        needs_plan = list(dict.fromkeys([*self.checkpoint.get("needs_plan", []), record["id"]]))
        self.commit(products=[result], checkpoint=dict(self.checkpoint, needs_plan=needs_plan))
        self.limits.processed += 1
        return result

    def plan_pending(self):
        pending = self.checkpoint.get("needs_plan", [])
        for record in self.lookup(pending):
            self.limits.check()
            meta = record["metadata"]
            center = meta.get("center") or {}
            ra = meta.get("center_ra", center.get("ra"))
            dec = meta.get("center_dec", center.get("dec"))
            if ra is None or dec is None:
                raise ValueError("A preprocessed product lacks its measured sky center.")
            neighbors = self.db.call("neighbors", p_ra=ra, p_dec=dec,
                                     p_detector=meta["detector"], p_limit=32)
            unique = {row["id"]: row for row in [record, *neighbors]}
            groups = plan_groups(list(unique.values()), max_groups=3)
            pending = [value for value in pending if value != record["id"]]
            self.commit(groups=groups, checkpoint=dict(self.checkpoint, needs_plan=pending))

    def search(self, group):
        self.limits.check()
        try:
            result = search_group(group, self.limits, catalog_checks=self.catalog_checks)
        except (requests.RequestException, ValueError, OSError, RuntimeError) as error:
            if isinstance(error, DatabaseError):
                raise
            if isinstance(error, requests.HTTPError) and error.response is not None and error.response.status_code in (429, 503):
                raise Paused("NASA archive throttled this session or is unavailable.") from error
            return {**group, **retry(group, str(error))}
        if result["candidates"]:
            self.catalog_checks = 0
        report = result["report"]
        if result["analysis"] is None or report.get("frameFailures"):
            return {**group, **retry(group, "DeepTrace did not produce a complete compatible analysis."),
                    "metadata": {**group["metadata"], "last_report": report}}
        return dict(group, state="searched", retry_at=None, candidates=result["candidates"],
                    metadata={**group["metadata"], "report": report, "analysis": result["analysis"]})

    def commit_search(self, group):
        result = self.search(group)
        self.commit(groups=[result])
        if result["state"] == "searched":
            self.limits.searched += 1
        return result

    def selected_region(self, position, *, job=None):
        ra, dec, fov, detector = position
        slot = f"request_{job['job_id']}" if job else "pilot"
        selection = self.checkpoint.get(slot)
        if selection is None:
            rows = read_search(self.session, ra, dec, detector, self.args.batch, self.limits)
            if not job:
                seeded = {row["id"]: row for row in pilot_seeds()}
                seeded.update({row["id"]: row for row in rows})
                rows = list(seeded.values())[:self.args.batch]
            selection = [record["id"] for record in rows]
            self.commit(products=rows, checkpoint=dict(self.checkpoint, **{slot: selection}))
        records = self.lookup(selection)
        valid = [record for record in records if record["state"] == "preprocessed"]
        for record in records:
            if due(record):
                result = self.preprocess(record)
                if result:
                    valid.append(result)
                    if not job and self.args.pilot_stop_after == self.limits.processed:
                        raise Paused("Pilot paused deliberately after committed products. Restart the saved notebook.")
        groups = plan_groups(valid, ra=ra, dec=dec, detector=detector or None, fov=fov, max_groups=3)
        known = {row["id"]: row for row in
                 self.db.call("groups", p_ids=[g["id"] for g in groups])} if groups else {}
        self.commit(groups=groups)
        searched = None
        for group in groups:
            old = known.get(group["id"])
            if old and old["state"] == "searched":
                searched = group["id"]
            elif not old or due(old):
                outcome = self.commit_search({**group, "attempts": old["attempts"] if old else 0})
                if outcome["state"] == "searched":
                    searched = group["id"]
        if job:
            outstanding = any(due(row) or row["state"] == "retry" for row in self.lookup(selection))
            outstanding |= any(row["state"] == "retry" for row in
                               self.db.call("groups", p_ids=[g["id"] for g in groups])) if groups else False
            state = "searched" if searched else "retry" if outstanding else "insufficient"
            message = {"searched": "DeepTrace completed a compatible sample.",
                       "retry": "Some real observations or comparisons need another attempt.",
                       "insufficient": "The bounded sample did not produce a complete compatible multi-epoch search."}[state]
            next_checkpoint = dict(self.checkpoint)
            if state != "retry" or job["attempts"] >= 3:
                next_checkpoint.pop(slot, None)
            self.commit(job=dict(job_id=job["job_id"], state=state, group_id=searched, message=message,
                                 retry_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()),
                        checkpoint=next_checkpoint)
        return len(selection), len(valid), searched

    def execute(self):
        if self.args.mode == "pilot":
            selected, valid, searched = self.selected_region(PILOT_POSITION)
            # Region planning uses only the fixed sample; discard duplicate general plans.
            self.commit(checkpoint=dict(self.checkpoint, needs_plan=[]))
            if valid < 10 or not searched:
                raise Paused(f"Pilot incomplete: {valid}/{selected} validated products, no verified pilot completion.")
            return "Pilot reached at least 10 validated products and one successful motion search."
        if self.job:
            self.selected_region(tuple(self.job[key] for key in ("ra", "dec", "fov", "detector")), job=self.job)
        for _ in range(self.args.batches):
            self.limits.check()
            self.plan_pending()
            for group in self.db.call("pending_groups", p_limit=2):
                self.commit_search(group)
            records = self.db.call("pending", p_limit=self.args.batch)
            if not records:
                rows, checkpoint = inventory_page(self.session, self.checkpoint, self.args.batch, self.limits)
                if not rows and checkpoint == self.checkpoint:
                    break
                self.commit(products=rows, checkpoint=checkpoint)
                records = self.db.call("pending", p_limit=self.args.batch)
            for record in records:
                self.preprocess(record)
            self.plan_pending()
        return "Scheduled batch allowance completed."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("pilot", "survey"), default="pilot")
    parser.add_argument("--batch", type=int, choices=range(10, 51), default=20, metavar="10..50")
    parser.add_argument("--batches", type=int, choices=range(1, 21), default=1, metavar="1..20")
    parser.add_argument("--minutes", type=int, choices=range(5, 481), default=45, metavar="5..480")
    parser.add_argument("--ram-mib", type=int, choices=range(2048, 8193), default=8192, metavar="2048..8192")
    parser.add_argument("--scratch-mib", type=int, choices=range(128, 2049), default=2048, metavar="128..2048")
    parser.add_argument("--transfer-mib", type=int, choices=range(128, 16385), default=2048, metavar="128..16384")
    parser.add_argument("--pilot-stop-after", type=int, choices=range(1, 50), metavar="1..49")
    args = parser.parse_args()
    if not Path("/kaggle/working").is_dir() or not os.getenv("KAGGLE_KERNEL_RUN_TYPE"):
        raise SystemExit("This worker requires a remote Kaggle notebook session.")
    if args.mode == "survey" and os.getenv("SLOWTRACE_PILOT_VERIFIED") != "yes":
        raise SystemExit("Enable survey mode in Kaggle only after the pilot and resume checks pass.")
    if args.mode == "pilot" and args.batches != 1:
        raise SystemExit("The pilot is restricted to one fixed sample.")
    if args.pilot_stop_after and (args.mode != "pilot" or args.pilot_stop_after >= args.batch):
        raise SystemExit("The interruption check requires pilot mode and fewer products than the batch cap.")
    cap = args.ram_mib * MIB
    _, hard_limit = resource.getrlimit(resource.RLIMIT_AS)
    if hard_limit != resource.RLIM_INFINITY:
        cap = min(cap, hard_limit)
    resource.setrlimit(resource.RLIMIT_AS, (cap, hard_limit))
    db = Database(os.environ["SLOWTRACE_SUPABASE_URL"], os.environ["SLOWTRACE_SUPABASE_SECRET_KEY"])
    claim = db.call("acquire", p_lease_seconds=LEASE_SECONDS, p_claim_jobs=args.mode == "survey")
    if not claim.get("lease_id"):
        print("Paused before NASA processing:", claim.get("reason", "lease unavailable"))
        return
    lease = claim["lease_id"]
    with tempfile.TemporaryDirectory(prefix="slowtrace-", dir="/tmp") as name:
        limits = Limits(args, Path(name), db, lease)
        status, reason = "error", "Worker stopped before completing the batch."
        def deadline(_signum, _frame):
            raise Paused("Session reached its execution deadline.")
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(args.minutes * 60)
        try:
            reason = Run(args, db, claim, limits).execute()
            status = "completed"
        except (Paused, KeyboardInterrupt, MemoryError) as error:
            status, reason = "paused", str(error) or "Run interrupted or RAM limit reached."
        except (DatabaseError, requests.RequestException, ValueError, OSError) as error:
            reason = str(error)[:300]
        finally:
            signal.alarm(0)
            usage = limits.usage()
            db.call("finish", p_lease_id=lease, p_status=status, p_reason=reason, p_usage=usage)
            print(status, reason, usage)
        if status == "error":
            raise SystemExit(1)


if __name__ == "__main__":
    main()
