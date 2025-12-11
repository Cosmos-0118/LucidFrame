import React from "react";

function BootOverlay({ show, status, backendUrl, onBackendChange, onRefresh, healthLoading }) {
  if (!show) return null;
  const unreachable = !healthLoading && status !== "ok";

  return (
    <div className="boot-overlay" role="status" aria-live="polite">
      <div className="boot-card">
        {healthLoading ? <div className="spinner" aria-label="Starting backend" /> : <div className="alert-icon" />}
        <p className="boot-text">{healthLoading ? "Starting app & backend…" : "Backend not reachable"}</p>
        <p className="boot-sub">
          {healthLoading ? "This can take a few seconds while models load." : "Update the URL if needed, then retry."}
        </p>
        <div className="backend inline">
          <label className="label" htmlFor="boot-backend-url">
            Backend URL
          </label>
          <input
            id="boot-backend-url"
            type="text"
            value={backendUrl}
            onChange={(e) => onBackendChange(e.target.value)}
            disabled={healthLoading}
          />
        </div>
        <button className="ghost" type="button" onClick={onRefresh} disabled={healthLoading && !unreachable}>
          {healthLoading ? "Checking…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

export default BootOverlay;
