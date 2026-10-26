import { IconFolder, IconUpload } from "./icons";

export default function EmptyState({ onAddFiles, onAddFolder }) {
  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-art" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h2>Drop images or videos here</h2>
        <p>Upscale up to 4× with modern AI models. Everything runs on your computer — nothing is uploaded.</p>
        <div className="empty-actions">
          <button type="button" className="btn primary" onClick={onAddFiles}>
            <IconUpload /> Choose files…
          </button>
          <button type="button" className="btn" onClick={onAddFolder}>
            <IconFolder /> Choose folder…
          </button>
        </div>
        <p className="formats">PNG · JPEG · WebP · TIFF · GIF · AVIF · MP4 · MOV · MKV · WebM · AVI</p>
      </div>
    </div>
  );
}
