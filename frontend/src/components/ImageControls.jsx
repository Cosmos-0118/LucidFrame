import React from "react";

function ImageControls({
  mode,
  scale,
  setMode,
  setScale,
  faceRestore,
  setFaceRestore,
  textSafe,
  setTextSafe,
  sharpenStrength,
  setSharpenStrength,
  advancedOpen,
  setAdvancedOpen,
  autoEnhance,
  setAutoEnhance,
  applyTonePreset,
  tonePreset,
  presetIntensity,
  setPresetIntensity,
  denoiseStrength,
  setDenoiseStrength,
  brightness,
  setBrightness,
  exposure,
  setExposure,
  contrast,
  setContrast,
  saturation,
  setSaturation,
  resetAdvanced,
  onDocumentPreset,
}) {
  return (
    <>
      <section className="controls">
        <div className="control-group">
          <span className="label">Mode</span>
          <select
            className="select"
            value={mode}
            onChange={(e) => {
              const val = e.target.value;
              setMode(val);
              if (val === "clean") setScale(4);
            }}
          >
            <option value="photo">Photo</option>
            <option value="anime">Anime</option>
            <option value="clean">Clean (ESRNet 4×)</option>
          </select>
        </div>
        <div className="control-group">
          <span className="label">Scale</span>
          <div className="pill-group">
            {[2, 4].map((value) => (
              <button
                key={value}
                className={`pill ${scale === value ? "active" : ""}`}
                onClick={() => setScale(value)}
                type="button"
              >
                {value}×
              </button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="label">Face restore</span>
          <label className="switch">
            <input type="checkbox" checked={faceRestore} onChange={(e) => setFaceRestore(e.target.checked)} />
            <span className="slider" />
          </label>
        </div>
        <div className="control-group">
          <span className="label">Text-safe</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={textSafe}
              onChange={(e) => {
                const v = e.target.checked;
                setTextSafe(v);
                if (v) {
                  setFaceRestore(false);
                  if (sharpenStrength < 0.25) setSharpenStrength(0.25);
                  setMode("photo");
                }
              }}
            />
            <span className="slider" />
          </label>
        </div>
        <div className="control-group slider-group">
          <span className="label">Sharpen</span>
          <div className="range-field">
            <input
              type="range"
              min="0"
              max="0.6"
              step="0.05"
              value={sharpenStrength}
              onChange={(e) => setSharpenStrength(Number(e.target.value))}
            />
            <span className="range-value">{sharpenStrength.toFixed(2)}</span>
          </div>
        </div>
      </section>

      <section className="advanced">
        <div className="advanced-head">
          <div>
            <span className="label">Advanced overrides</span>
            <p className="hint small">Tone tweaks apply per request and reset anytime.</p>
          </div>
          <div className="advanced-actions">
            <button type="button" className="ghost small" onClick={() => setAdvancedOpen((v) => !v)}>
              {advancedOpen ? "Hide tweaks" : "Show tweaks"}
            </button>
            <button type="button" className="ghost small" onClick={resetAdvanced}>
              Reset tweaks
            </button>
          </div>
        </div>

        {advancedOpen && (
          <div className="controls advanced-grid">
            <div className="control-group">
              <span className="label">Auto-enhance</span>
              <label className="switch">
                <input type="checkbox" checked={autoEnhance} onChange={(e) => setAutoEnhance(e.target.checked)} />
                <span className="slider" />
              </label>
            </div>
            <div className="control-group">
              <span className="label">Document preset</span>
              <button type="button" className="ghost small" onClick={onDocumentPreset}>
                Text-safe boost
              </button>
            </div>
            <div className="control-group">
              <span className="label">Tone preset</span>
              <select className="select" value={tonePreset} onChange={(e) => applyTonePreset(e.target.value)}>
                <option value="none">None</option>
                <option value="night">Night fix</option>
                <option value="portrait">Portrait clean</option>
                <option value="print">Print-ready</option>
              </select>
            </div>
            <div className="control-group slider-group">
              <span className="label">Preset intensity</span>
              <div className="range-field">
                <input
                  type="range"
                  min="0.6"
                  max="1.6"
                  step="0.05"
                  value={presetIntensity}
                  onChange={(e) => setPresetIntensity(Number(e.target.value))}
                  disabled={tonePreset === "none"}
                />
                <span className="range-value">{presetIntensity.toFixed(2)}</span>
              </div>
            </div>
            <div className="control-group slider-group">
              <span className="label">Denoise</span>
              <div className="range-field">
                <input
                  type="range"
                  min="0"
                  max="0.3"
                  step="0.02"
                  value={denoiseStrength}
                  onChange={(e) => setDenoiseStrength(Number(e.target.value))}
                />
                <span className="range-value">{denoiseStrength.toFixed(2)}</span>
              </div>
            </div>
            <div className="control-group slider-group">
              <span className="label">Brightness</span>
              <div className="range-field">
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                />
                <span className="range-value">{brightness.toFixed(2)}</span>
              </div>
            </div>
            <div className="control-group slider-group">
              <span className="label">Exposure</span>
              <div className="range-field">
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  value={exposure}
                  onChange={(e) => setExposure(Number(e.target.value))}
                />
                <span className="range-value">{exposure.toFixed(2)}</span>
              </div>
            </div>
            <div className="control-group slider-group">
              <span className="label">Contrast</span>
              <div className="range-field">
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  value={contrast}
                  onChange={(e) => setContrast(Number(e.target.value))}
                />
                <span className="range-value">{contrast.toFixed(2)}</span>
              </div>
            </div>
            <div className="control-group slider-group">
              <span className="label">Saturation</span>
              <div className="range-field">
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  value={saturation}
                  onChange={(e) => setSaturation(Number(e.target.value))}
                />
                <span className="range-value">{saturation.toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

export default ImageControls;
