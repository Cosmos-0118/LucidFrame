import React from "react";
import { defaultBackend } from "../utils";

function HeaderBar({ backendUrl, onBackendChange, onRefresh, healthLoading }) {
  return (
    <header className="header">
      <div>
        <p className="eyebrow">LucidFrame · MVP</p>
        <h1>Upscale with confidence.</h1>
        <p className="lede">Drop media, pick a mode, and let the backend do the heavy lifting.</p>
      </div>
      <div className="backend">
        <label className="label" htmlFor="backend-url">
          Backend URL
        </label>
        <input
          id="backend-url"
          type="text"
          value={backendUrl}
          onChange={(e) => onBackendChange(e.target.value)}
          placeholder={defaultBackend}
        />
        <button className="ghost" type="button" onClick={onRefresh} disabled={healthLoading}>
          {healthLoading ? "Checking…" : "Refresh health"}
        </button>
      </div>
    </header>
  );
}

export default HeaderBar;
