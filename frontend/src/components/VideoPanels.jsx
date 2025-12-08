import React from "react";

function VideoPanels({ videoSrcUrl, videoOutUrl, videoJobId }) {
  return (
    <section className="video-grid">
      <div className="panel">
        <div className="panel-head">
          <span className="chip">Source</span>
          {videoJobId && <span className="meta">Job: {videoJobId}</span>}
        </div>
        <div className="panel-body">
          {videoSrcUrl ? <video src={videoSrcUrl} controls className="video-player" /> : <p className="placeholder">No video yet</p>}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="chip">Output</span>
          <span className="meta">Preview + download</span>
        </div>
        <div className="panel-body">
          {videoOutUrl ? (
            <video src={videoOutUrl} controls className="video-player" />
          ) : (
            <p className="placeholder">Waiting for completion</p>
          )}
        </div>
      </div>
    </section>
  );
}

export default VideoPanels;
