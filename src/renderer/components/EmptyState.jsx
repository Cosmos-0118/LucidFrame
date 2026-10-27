import { IconFolder, IconImage, IconUpload } from "./icons";

const FORMATS = ["PNG", "JPEG", "WebP", "TIFF", "GIF", "AVIF", "MP4", "MOV", "MKV", "WebM", "AVI"];

export default function EmptyState({ onAddFiles, onAddFolder }) {
  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-icon" aria-hidden="true">
          <IconImage size={22} />
        </div>
        <h2>Drop images or videos here</h2>
        <p>Upscale up to 4× and repair blur, JPEG damage and faces. Everything runs on your computer — nothing is uploaded.</p>
        <div className="empty-actions">
          <button type="button" className="btn primary" onClick={onAddFiles}>
            <IconUpload size={16} /> Choose files
          </button>
          <button type="button" className="btn" onClick={onAddFolder}>
            <IconFolder size={16} /> Choose folder
          </button>
        </div>
        <div className="formats" aria-label="Supported formats">
          {FORMATS.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
