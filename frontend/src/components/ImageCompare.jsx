import React from "react";

function ImageCompare({
  beforeUrl,
  afterUrl,
  status,
  showAfter,
  setShowAfter,
  loading,
  inputHint,
  error,
}) {
  const showPreviewOverlay = loading || error;

  return (
    <section className="compare">
      <div className="panel-head">
        <span className="chip">Before / After</span>
        {status && <span className="meta status-pill">{status}</span>}
        <button type="button" className="ghost small" onClick={() => setShowAfter((v) => !v)} disabled={!afterUrl}>
          {showAfter ? "Show Before" : "Show After"}
        </button>
      </div>
      <div className="compare-body">
        {showPreviewOverlay && (
          <div className="preview-overlay" role="status" aria-live="polite">
            {loading && <div className="preview-spinner" aria-label={status || "Processing"} />}
            <div className="preview-status-text">{loading ? status || "Working…" : "Error"}</div>
            {loading && inputHint && <div className="preview-hint">{inputHint}</div>}
            {error && <div className="preview-error">{error}</div>}
          </div>
        )}
        <div className="compare-frame">
          {loading && !afterUrl ? (
            <div className="skeleton skeleton-img" aria-label="Loading preview" />
          ) : (
            <img
              src={showAfter && afterUrl ? afterUrl : beforeUrl}
              alt={showAfter && afterUrl ? "After" : "Before"}
              className="compare-img"
            />
          )}
        </div>
      </div>
    </section>
  );
}

export default ImageCompare;
