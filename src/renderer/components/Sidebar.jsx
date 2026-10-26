import { fits, fmtDims, megapixels } from "../utils";
import { IconAlert, IconChip, IconFolder, Logo } from "./icons";

const SCALE_LABELS = { 2: "2×", 3: "3×", 4: "4×" };

function Device({ device }) {
  const busy = device.state === "detecting";
  const cls = device.state === "error" ? "error" : device.provider && device.provider !== "cpu" ? "gpu" : "cpu";
  return (
    <div className={`device ${cls}`} title="The hardware LucidFrame uses for upscaling">
      {busy ? <span className="spinner" aria-hidden="true" /> : <IconChip size={15} />}
      <span>{device.label}</span>
    </div>
  );
}

export default function Sidebar({ info, device, options, setOptions, selected, hasItems, hasImage, hasVideo, settings, onChooseFolder, onResetFolder, queuedCount, running, onStart, onCancel }) {
  const model = info.models.find((m) => m.id === options.model) ?? info.models[0];
  const dims = selected?.dims;
  const out = dims ? { w: dims.w * options.scale, h: dims.h * options.scale } : null;
  const tooBig = dims && !fits(dims.w, dims.h, options.scale, model.scale);
  const slowCpu = device.provider === "cpu" && model.kind === "quality";
  const videoQuality = hasVideo && model.kind === "quality";

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
      <header className="brand">
        <Logo />
        <div>
          <h1>LucidFrame</h1>
          <p>Private AI upscaling</p>
        </div>
      </header>

      <section className="group" aria-labelledby="g-model">
        <h2 id="g-model">Model</h2>
        <div className="models" role="radiogroup" aria-label="Model">
          {info.models.map((m) => (
            <label key={m.id} className={`model ${options.model === m.id ? "checked" : ""}`}>
              <input type="radio" name="model" value={m.id} checked={options.model === m.id} onChange={() => setOptions({ model: m.id, scale: m.scale })} disabled={!m.available || running} />
              <span className="model-name">
                {m.name}
                <span className={`badge ${m.kind}`}>{m.kind === "quality" ? "Best quality" : "Fast"}</span>
              </span>
              <span className="model-tag">{m.tagline}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="group" aria-labelledby="g-scale">
        <h2 id="g-scale">Scale</h2>
        <div className="segmented" role="radiogroup" aria-label="Scale">
          {info.scales.map((s) => (
            <label key={s} className={options.scale === s ? "checked" : ""}>
              <input type="radio" name="scale" value={s} checked={options.scale === s} onChange={() => setOptions({ scale: s })} disabled={running} />
              {SCALE_LABELS[s]}
            </label>
          ))}
        </div>
        {out && (
          <p className={`hint ${tooBig ? "bad" : ""}`}>
            {fmtDims(dims.w, dims.h)} → {fmtDims(out.w, out.h)} <span className="muted">({megapixels(out.w, out.h).toFixed(megapixels(out.w, out.h) < 1 ? 2 : 1)} MP)</span>
          </p>
        )}
        {tooBig && (
          <p className="callout danger">
            <IconAlert size={15} /> Too large for this scale. Choose a smaller scale.
          </p>
        )}
      </section>

      {hasImage && (
        <section className="group" aria-labelledby="g-format">
          <h2 id="g-format">Image format</h2>
          <select className="select" value={options.format} onChange={(e) => setOptions({ format: e.target.value })} disabled={running} aria-label="Image format">
            <option value="auto">Auto (match original)</option>
            <option value="png">PNG — lossless</option>
            <option value="jpeg">JPEG — smaller</option>
            <option value="webp">WebP — smaller</option>
          </select>
        </section>
      )}

      {hasVideo && (
        <section className="group" aria-labelledby="g-video">
          <h2 id="g-video">Video</h2>
          <label className="switch-row">
            <span>
              Smooth motion
              <span className="hint">Doubles the frame rate with motion interpolation. Slower.</span>
            </span>
            <input type="checkbox" role="switch" checked={options.smooth} onChange={(e) => setOptions({ smooth: e.target.checked })} disabled={running} />
          </label>
        </section>
      )}

      <section className="group" aria-labelledby="g-save">
        <h2 id="g-save">Save to</h2>
        <div className="save-row">
          <IconFolder size={16} />
          <span className="save-path" title={settings.outputDir ?? "Same folder as each original"}>
            {settings.outputDir ?? "Next to each original"}
          </span>
        </div>
        <div className="save-actions">
          <button type="button" className="btn small" onClick={onChooseFolder} disabled={running}>
            Choose folder…
          </button>
          {settings.outputDir && (
            <button type="button" className="btn small ghost" onClick={onResetFolder} disabled={running}>
              Reset
            </button>
          )}
        </div>
        <p className="hint">Originals are never changed or overwritten.</p>
      </section>

      </div>
      <div className="cta">
        {(slowCpu || videoQuality) && (
          <p className="callout warn">
            <IconAlert size={15} />
            <span>
              {videoQuality
                ? "Quality models are very slow on video — hours for a few minutes of footage. Choose Fast for video."
                : "No GPU acceleration found, so quality models can take a minute or more per megapixel. Fast is about 25× quicker."}
            </span>
          </p>
        )}
        {running ? (
          <button type="button" className="btn primary wide" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn primary wide" onClick={onStart} disabled={queuedCount === 0 || (selected && tooBig && selected.status === "queued")}>
            {queuedCount > 0 ? `Upscale ${queuedCount} ${queuedCount === 1 ? "file" : "files"}` : hasItems ? "All done" : "Add files to begin"}
          </button>
        )}
        <Device device={device} />
      </div>
    </aside>
  );
}
