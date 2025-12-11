import React from "react";

function BootOverlay({ show }) {
  if (!show) return null;
  return (
    <div className="boot-overlay" role="status" aria-live="polite">
      <div className="boot-card">
        <div className="spinner" aria-label="Starting backend" />
        <p className="boot-text">Starting app & backend…</p>
        <p className="boot-sub">This can take a few seconds while models load.</p>
      </div>
    </div>
  );
}

export default BootOverlay;
