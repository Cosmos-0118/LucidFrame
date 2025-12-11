import React from "react";

function SettingsPanel({ modelDir, ffmpegPath, tileSize, useFp16, onModelDir, onFfmpegPath, onTileSize, onFp16, health }) {
  return (
    <section className="settings">
      <div className="panel">
        <div className="panel-head">
          <span className="chip">Settings</span>
          <span className="meta">Step 4.4</span>
        </div>
        <div className="settings-grid">
          <label className="field">
            <span className="label">Models directory</span>
            <input type="text" value={modelDir} onChange={(e) => onModelDir(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">FFmpeg path</span>
            <input type="text" value={ffmpegPath} onChange={(e) => onFfmpegPath(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Tile size</span>
            <input type="number" min="64" max="512" value={tileSize} onChange={(e) => onTileSize(e.target.value)} />
          </label>
          <label className="field switch-field">
            <span className="label">FP16</span>
            <label className="switch">
              <input type="checkbox" checked={useFp16} onChange={(e) => onFp16(e.target.checked)} />
              <span className="slider" />
            </label>
          </label>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="chip">System</span>
          <span className="meta">Health</span>
        </div>
        <div className="system">
          <p className="meta">Status: {health.status}</p>
          {health.device && <p className="meta">Device: {health.device}</p>}
          {health.version && <p className="meta">Backend v{health.version}</p>}
          {health.amp !== undefined && (
            <p className="meta">AMP: {health.amp ? "on" : "off"} · Half: {health.half ? "yes" : "no"}</p>
          )}
          <p className="hint">Settings are stored locally for now.</p>
        </div>
      </div>
    </section>
  );
}

export default SettingsPanel;
