import { useState } from "react";
import { fmtBytes, fmtDims } from "../utils";
import { IconAlert, IconCheck, IconFolder, IconImage, IconUpload, IconVideo, IconX } from "./icons";

function Status({ item }) {
  switch (item.status) {
    case "running":
      return (
        <span className="status running">
          <span className="mini-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(4, Math.round((item.progress?.fraction ?? 0) * 100))}%` }} />
          </span>
          {Math.round((item.progress?.fraction ?? 0) * 100)}%
        </span>
      );
    case "done":
      return (
        <span className="status done">
          <IconCheck size={14} /> {item.result.scale}× · {fmtDims(item.result.width, item.result.height)}
        </span>
      );
    case "error":
      return (
        <span className="status error" title={item.error}>
          <IconAlert size={14} /> Failed
        </span>
      );
    case "cancelled":
      return <span className="status">Cancelled</span>;
    default:
      return <span className="status">Waiting</span>;
  }
}

function ImageThumb({ url }) {
  const [failed, setFailed] = useState(false);
  return failed || !url ? <IconImage /> : <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

export default function Queue({ state, running, onSelect, onRemove, onClear, onAddFiles, onAddFolder }) {
  const { items, selectedId } = state;
  return (
    <section className="queue" aria-label="Queue">
      <header className="queue-head">
        <h2>
          Queue <span className="count">{items.length}</span>
        </h2>
        <div className="queue-actions">
          <button type="button" className="btn small" onClick={onAddFiles}>
            <IconUpload size={15} /> Add files
          </button>
          <button type="button" className="btn small" onClick={onAddFolder}>
            <IconFolder size={15} /> Add folder
          </button>
          <button type="button" className="btn small ghost" onClick={onClear} disabled={items.every((i) => i.status === "running")}>
            Clear
          </button>
        </div>
      </header>
      <ul className="queue-list">
        {items.map((item) => (
          <li key={item.id} className={`row ${item.id === selectedId ? "selected" : ""}`}>
            <button type="button" className="row-main" onClick={() => onSelect(item.id)} aria-current={item.id === selectedId}>
              <span className="row-icon">{item.kind === "video" ? <IconVideo /> : <ImageThumb url={item.sourceUrl} />}</span>
              <span className="row-text">
                <span className="row-name" title={item.path}>{item.name}</span>
                <span className="row-meta">
                  {fmtBytes(item.size)}
                  {item.dims ? ` · ${fmtDims(item.dims.w, item.dims.h)}` : ""}
                </span>
              </span>
              <Status item={item} />
            </button>
            <button type="button" className="icon-btn" onClick={() => onRemove(item.id)} disabled={item.status === "running"} aria-label={`Remove ${item.name}`} title="Remove">
              <IconX size={15} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
