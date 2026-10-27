const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false };
const make = (d) =>
  function Icon({ size, ...rest }) {
    return (
      <svg {...base} {...(size ? { width: size, height: size } : {})} {...rest}>
        {d}
      </svg>
    );
  };

export const IconImage = make(
  <>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="9" cy="9" r="1.6" />
    <path d="m21 15-4.5-4.5L8 19" />
  </>,
);
export const IconVideo = make(
  <>
    <rect x="3" y="5" width="13" height="14" rx="3" />
    <path d="m16 10 5-3v10l-5-3" />
  </>,
);
export const IconFolder = make(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
export const IconCheck = make(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconX = make(<path d="M6 6l12 12M18 6 6 18" />);
export const IconAlert = make(
  <>
    <path d="M12 3 2.5 20h19z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </>,
);
export const IconUpload = make(
  <>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </>,
);
export const IconZoomIn = make(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M11 8v6M8 11h6" />
  </>,
);
export const IconZoomOut = make(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M8 11h6" />
  </>,
);
export const IconFit = make(<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />);
export const IconReveal = make(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="m10 13 2 2 3-3.5" />
  </>,
);
export const IconDownload = make(
  <>
    <path d="M12 4v12M7 11l5 5 5-5" />
    <path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
  </>,
);
export const IconRedo = make(
  <>
    <path d="M20 5v5h-5" />
    <path d="M20 10a8 8 0 1 0 1.2 4.2" />
  </>,
);
export const IconChip = make(
  <>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </>,
);

export const IconInfo = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.5v.01" />
  </>,
);

export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="8" style={{ fill: "var(--text)" }} />
      <path d="M10.5 9v14h11" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--bg)" }} />
      <path d="M15.5 14.5V19h4.5" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" strokeOpacity=".5" style={{ stroke: "var(--bg)" }} />
    </svg>
  );
}
