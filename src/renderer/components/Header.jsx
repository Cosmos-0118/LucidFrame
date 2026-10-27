import { Logo } from "./icons";

const STATE_LABELS = { queued: "Waiting", running: "Upscaling", done: "Done", error: "Failed", cancelled: "Cancelled" };

function Device({ device }) {
  const busy = device.state === "detecting";
  const cls = device.state === "error" ? "error" : device.provider && device.provider !== "cpu" ? "gpu" : "cpu";
  return (
    <div className={`device ${cls}`} title="The hardware LucidFrame uses for upscaling">
      {busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot-state" aria-hidden="true" />}
      <span>{device.label}</span>
    </div>
  );
}

export default function Header({ device, selected }) {
  return (
    <header className="header">
      <div className="brand">
        <Logo size={22} />
        <span>LucidFrame</span>
      </div>
      {selected && (
        <div className="crumb">
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-name" title={selected.path}>{selected.name}</span>
          <span className={`crumb-state ${selected.status}`}>{STATE_LABELS[selected.status] ?? selected.status}</span>
        </div>
      )}
      <div className="spacer" />
      <Device device={device} />
    </header>
  );
}
