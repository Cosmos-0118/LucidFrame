import { useEffect, useState } from "react";
import { fmtDims, fmtDuration } from "../utils";
import CompareViewer from "./CompareViewer";
import { IconAlert, IconDownload, IconRedo, IconReveal, IconX } from "./icons";

function ProgressCard({ item, onCancel }) {
  const p = item.progress ?? { fraction: 0 };
  const pct = Math.round((p.fraction ?? 0) * 100);
  const detail = [];
  if (p.frame) detail.push(`Frame ${p.frame.toLocaleString()}${p.frames ? ` of ${p.frames.toLocaleString()}` : ""}`);
  if (p.fps) detail.push(`${p.fps.toFixed(1)} fps`);
  if (p.etaSeconds > 1) detail.push(`about ${fmtDuration(p.etaSeconds)} left`);
  return (
    <div className="overlay" role="status" aria-live="polite">
      <div className="progress-card">
        <div className="progress-title">{p.message || (item.kind === "video" ? "Upscaling video" : "Upscaling")}</div>
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress">
          <div className="bar-fill" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
        <div className="progress-meta">
          <span className="pct">{pct}%</span>
          <span>{detail.join(" · ")}</span>
        </div>
        <button type="button" className="btn ghost" onClick={onCancel}>
          <IconX /> Cancel
        </button>
      </div>
    </div>
  );
}

function ResultBar({ item, actions }) {
  const r = item.result;
  return (
    <div className="result-bar">
      <div className="result-info">
        <strong>{fmtDims(r.sourceWidth, r.sourceHeight)}</strong>
        <span aria-hidden="true">→</span>
        <strong>{fmtDims(r.width, r.height)}</strong>
        <span className="dot" aria-hidden="true">·</span>
        <span>{fmtDuration(r.seconds) || `${r.seconds.toFixed(1)}s`}</span>
        <span className="dot" aria-hidden="true">·</span>
        <span>{r.device?.label}</span>
        {r.kind === "video" && r.smooth && (
          <>
            <span className="dot" aria-hidden="true">·</span>
            <span>{r.fps} fps</span>
          </>
        )}
      </div>
      {(r.restore?.cleanup?.applied || r.restore?.faces?.restored > 0) && (
        <div className="chips" aria-label="Restoration applied">
          {r.restore.cleanup.applied && (
            <span className="chip">
              {r.restore.cleanup.reasons?.includes("blur") && r.restore.cleanup.reasons?.includes("blocks")
                ? "Blocks and blur cleaned up"
                : r.restore.cleanup.reasons?.includes("blur")
                  ? "Blur reduced"
                  : "Compression blocks removed"}
            </span>
          )}
          {r.restore.faces.restored > 0 && <span className="chip">{r.restore.faces.restored === 1 ? "1 face restored" : `${r.restore.faces.restored} faces restored`}</span>}
        </div>
      )}
      {r.warnings?.map((w) => (
        <div className="inline-warning" key={w}>
          <IconAlert size={14} /> {w}
        </div>
      ))}
      <div className="result-actions">
        <button type="button" className="btn" onClick={() => actions.reveal(r.output)}>
          <IconReveal /> Show in folder
        </button>
        <button type="button" className="btn" onClick={() => actions.saveCopy(r.output)}>
          <IconDownload /> Save a copy…
        </button>
        <button type="button" className="btn ghost" onClick={() => actions.redo(item.id)} title="Run again with the current settings">
          <IconRedo /> Redo
        </button>
      </div>
      <div className="result-path" title={r.output}>
        Saved as <button type="button" className="link" onClick={() => actions.open(r.output)}>{r.outputName}</button>
      </div>
    </div>
  );
}

function VideoResult({ item }) {
  const [tab, setTab] = useState("after");
  const r = item.result;
  useEffect(() => setTab("after"), [item.id]);
  return (
    <div className="video-result">
      <div className="tabs" role="tablist" aria-label="Video version">
        {[
          ["after", "Upscaled"],
          ["before", "Original"],
        ].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <video key={tab + item.id} className="video" src={tab === "after" ? r.outputUrl : item.sourceUrl} controls autoPlay muted loop />
    </div>
  );
}

export default function Viewer({ item, actions, onDims, onCancel }) {
  const done = item.status === "done" && item.result;
  const running = item.status === "running";
  let body;

  if (done && item.kind === "image") {
    const r = item.result;
    body = <CompareViewer before={item.sourceUrl} after={r.previewUrl ?? r.outputUrl} width={r.width} height={r.height} />;
  } else if (done && item.kind === "video") {
    body = <VideoResult item={item} />;
  } else if (item.kind === "image") {
    body = (
      <div className={`source ${running ? "dim" : ""}`}>
        <img src={item.sourceUrl} alt={item.name} onLoad={(e) => onDims(item.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} draggable={false} />
      </div>
    );
  } else {
    body = (
      <div className={`source ${running ? "dim" : ""}`}>
        <video src={item.sourceUrl} controls={!running} muted preload="metadata" onLoadedMetadata={(e) => onDims(item.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
      </div>
    );
  }

  return (
    <section className="viewer" aria-label={`Preview of ${item.name}`}>
      <div className="viewer-body">
        {body}
        {running && <ProgressCard item={item} onCancel={onCancel} />}
        {item.status === "error" && (
          <div className="overlay" role="alert">
            <div className="progress-card error">
              <IconAlert size={28} />
              <div className="progress-title">Couldn’t upscale this file</div>
              <p className="error-text">{item.error}</p>
              <button type="button" className="btn" onClick={() => actions.redo(item.id)}>
                <IconRedo /> Try again
              </button>
            </div>
          </div>
        )}
        {item.status === "cancelled" && (
          <div className="overlay">
            <div className="progress-card">
              <div className="progress-title">Cancelled</div>
              <button type="button" className="btn" onClick={() => actions.redo(item.id)}>
                <IconRedo /> Queue again
              </button>
            </div>
          </div>
        )}
      </div>
      {done && <ResultBar item={item} actions={actions} />}
    </section>
  );
}
