import { useId, useState } from "react";
import type { FormEvent } from "react";
import { ArrowUpRight, ChevronDown, Radar } from "lucide-react";
import {
  cloudJobParam,
  jobLabels,
  queueCloudJob,
  signInCloudOwner,
  useCloudConnection,
} from "./cloudSurvey";
import type { CloudJob, CloudSession } from "./cloudSurvey";
import { parseCoordinate } from "./observation";
import type { Query } from "./types";
import "./cloud-survey.css";

export default function AutomaticDetection({
  raText,
  decText,
  fov,
  detector,
}: Omit<Query, "ra" | "dec"> & { raText: string; decText: string }) {
  const panel = useId();
  const [open, setOpen] = useState(false);
  const connection = useCloudConnection(open);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [pending, setPending] = useState(false);
  const [job, setJob] = useState<CloudJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    event.currentTarget.reset();
    setError(null);
    setPending(true);
    try {
      setSession(await signInCloudOwner(String(data.get("email")), String(data.get("password"))));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in could not finish.");
    } finally {
      setPending(false);
    }
  }

  async function submitDetection() {
    if (!session || pending) return;
    setError(null);
    if (session.expires_at <= Date.now() / 1000) {
      setSession(null);
      setError("Your survey session expired. Sign in again to queue this field.");
      return;
    }
    setPending(true);
    try {
      const ra = parseCoordinate(raText, "ra");
      const dec = parseCoordinate(decText, "dec");
      setJob(await queueCloudJob({ ra, dec, fov, detector }, session.access_token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The field could not be queued.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auto-detection">
      <button
        type="button"
        className="secondary auto-detection-toggle"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
      >
        <Radar size={15} aria-hidden="true" /> Automatic detection
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div className="auto-detection-panel" id={panel} hidden={!open}>
        {connection === "connected" ? (
          <>
            <p>
              Queue a Kaggle motion search for the coordinates, field size and detector above.
              The survey owner can submit a field. Results appear after a worker session analyzes
              compatible SPHEREx observations.
            </p>
            {session ? (
              <div className="auto-detection-actions">
                <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void submitDetection()}>
                  {pending ? "Queueing…" : "Queue this field"}
                </button>
                <button type="button" className="secondary" disabled={pending} onClick={() => { setSession(null); setError(null); }}>
                  Sign out
                </button>
              </div>
            ) : (
              <form className="auto-detection-actions" onSubmit={(event) => void signIn(event)}>
                <label>
                  Owner email
                  <input type="email" name="email" autoComplete="username" required disabled={pending} />
                </label>
                <label>
                  Owner password
                  <input type="password" name="password" autoComplete="current-password" required disabled={pending} />
                </label>
                <button type="submit" className="secondary" disabled={pending}>
                  {pending ? "Signing in…" : "Sign in"}
                </button>
              </form>
            )}
          </>
        ) : (
          <p role="status">{connection === "checking" ? "Checking the remote survey…" :
            connection === "unavailable" ? "The remote survey is temporarily unavailable." :
              "Automatic detection becomes available when the survey owner connects the Kaggle worker and remote database."}</p>
        )}
        {error && <p className="auto-detection-error" role="alert">{error}</p>}
        {job && (
          <p role="status">
            {jobLabels[job.state]} · {job.ra.toFixed(5)}°, {job.dec.toFixed(5)}°{" "}
            <a href={`?page=stats&${cloudJobParam}=${encodeURIComponent(job.job_id)}`}>
              Open search status <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
