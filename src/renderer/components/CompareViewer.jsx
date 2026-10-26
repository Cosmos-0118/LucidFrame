import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clamp } from "../utils";
import { IconFit, IconZoomIn, IconZoomOut } from "./icons";

const MAX_ZOOM = 16;

/**
 * Before/after viewer. The content box has the *result's* pixel size; zoom 1 = 100% of the saved file.
 * Both images are laid into that same box so features line up exactly, and the divider clips the
 * "before" layer. Wheel zooms around the cursor, drag pans, the divider is draggable and keyboard-operable.
 */
export default function CompareViewer({ before, after, width, height, beforeLabel = "Original", afterLabel = "Upscaled" }) {
  const hostRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ mode: "fit", zoom: 1, tx: 0, ty: 0 });
  const [split, setSplit] = useState(0.5);
  const drag = useRef(null);

  useLayoutEffect(() => {
    const el = hostRef.current;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitZoom = box.w && box.h ? Math.min(box.w / width, box.h / height) : 1;
  const zoom = view.mode === "fit" ? fitZoom : view.zoom;
  const tx = view.mode === "fit" ? (box.w - width * zoom) / 2 : view.tx;
  const ty = view.mode === "fit" ? (box.h - height * zoom) / 2 : view.ty;

  // Reset to "fit" when a different image is shown.
  useEffect(() => setView({ mode: "fit", zoom: 1, tx: 0, ty: 0 }), [after, width, height]);

  const zoomAt = useCallback(
    (factor, cx, cy) => {
      setView((v) => {
        const cur = v.mode === "fit" ? fitZoom : v.zoom;
        const curTx = v.mode === "fit" ? (box.w - width * cur) / 2 : v.tx;
        const curTy = v.mode === "fit" ? (box.h - height * cur) / 2 : v.ty;
        const next = clamp(cur * factor, Math.min(fitZoom, 1) * 0.5, MAX_ZOOM);
        const k = next / cur;
        return { mode: "custom", zoom: next, tx: cx - (cx - curTx) * k, ty: cy - (cy - curTy) * k };
      });
    },
    [box.h, box.w, fitZoom, height, width],
  );

  // React's onWheel is passive; zooming needs preventDefault.
  useEffect(() => {
    const el = hostRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const rect = hostRef.current.getBoundingClientRect();
    if (e.target.closest?.("[data-divider]")) {
      drag.current = { kind: "split" };
    } else {
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, tx, ty };
    }
    hostRef.current.setPointerCapture(e.pointerId);
    if (drag.current.kind === "split") setSplit(clamp((e.clientX - rect.left) / rect.width, 0, 1));
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "split") {
      const rect = hostRef.current.getBoundingClientRect();
      setSplit(clamp((e.clientX - rect.left) / rect.width, 0, 1));
    } else {
      setView({ mode: "custom", zoom, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) });
    }
  };
  const onPointerUp = () => (drag.current = null);

  const onDoubleClick = (e) => {
    if (e.target.closest?.("[data-divider]")) return;
    const rect = hostRef.current.getBoundingClientRect();
    if (view.mode === "fit" && fitZoom < 1) zoomAt(1 / fitZoom, e.clientX - rect.left, e.clientY - rect.top);
    else setView({ mode: "fit", zoom: 1, tx: 0, ty: 0 });
  };

  const onKeyDown = (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") setSplit((s) => clamp(s - step, 0, 1));
    else if (e.key === "ArrowRight") setSplit((s) => clamp(s + step, 0, 1));
    else if (e.key === "Home") setSplit(0);
    else if (e.key === "End") setSplit(1);
    else return;
    e.preventDefault();
  };

  const layerStyle = { width: width * zoom, height: height * zoom, transform: `translate(${tx}px, ${ty}px)` };
  const percent = Math.round(zoom * 100);
  const center = () => [box.w / 2, box.h / 2];

  return (
    <div className="compare">
      <div
        ref={hostRef}
        className="compare-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <div className="compare-layer">
          <img className="compare-img" src={after} alt={afterLabel} style={layerStyle} draggable={false} />
        </div>
        <div className="compare-layer" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}>
          <img className="compare-img" src={before} alt={beforeLabel} style={layerStyle} draggable={false} />
        </div>
        <span className="compare-tag left">{beforeLabel}</span>
        <span className="compare-tag right">{afterLabel}</span>
        <div className="divider" data-divider style={{ left: `${split * 100}%` }}>
          <div
            className="divider-handle"
            role="slider"
            tabIndex={0}
            aria-label="Comparison divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split * 100)}
            aria-valuetext={`${Math.round(split * 100)}% ${beforeLabel}`}
            onKeyDown={onKeyDown}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M7 5 3 10l4 5M13 5l4 5-4 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>
      <div className="compare-tools" role="group" aria-label="Zoom">
        <button type="button" className="icon-btn" onClick={() => zoomAt(1 / 1.5, ...center())} aria-label="Zoom out" title="Zoom out">
          <IconZoomOut />
        </button>
        <button type="button" className="zoom-readout" onClick={() => zoomAt(1 / zoom, ...center())} title="Actual size (100%)">
          {percent}%
        </button>
        <button type="button" className="icon-btn" onClick={() => zoomAt(1.5, ...center())} aria-label="Zoom in" title="Zoom in">
          <IconZoomIn />
        </button>
        <button type="button" className="icon-btn" onClick={() => setView({ mode: "fit", zoom: 1, tx: 0, ty: 0 })} aria-label="Fit to window" title="Fit to window">
          <IconFit />
        </button>
      </div>
    </div>
  );
}
