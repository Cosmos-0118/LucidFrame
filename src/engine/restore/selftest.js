// A drawn face for the self-check ("Help → Run self-check", `lucidframe doctor`).
//
// The check proves that face restoration runs on this machine's GPU or CPU, so it needs something the restorer
// treats as a face: a flat grey square makes a codebook restorer invent a face that looks nothing like its input,
// and the GPU sanity check (isPlausibleRestoration) rightly takes that for broken output. A soft drawing with the
// eyes, nose and mouth where the model expects them behaves like a real, slightly blurry photo.

import sharp from "sharp";
import { CROP } from "./faces.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${CROP}" height="${CROP}" viewBox="0 0 512 512">
  <defs><filter id="soft" x="0" y="0" width="100%" height="100%"><feGaussianBlur stdDeviation="6"/></filter></defs>
  <g filter="url(#soft)">
    <rect width="512" height="512" fill="rgb(120,130,140)"/>
    <ellipse cx="256" cy="150" rx="120" ry="70" fill="rgb(70,50,40)"/>
    <ellipse cx="256" cy="271" rx="140" ry="180" fill="rgb(205,160,135)" stroke="rgb(189,147,124)" stroke-width="8"/>
    <ellipse cx="193" cy="240" rx="34" ry="15" fill="rgb(240,235,230)"/><circle cx="193" cy="240" r="11" fill="rgb(70,50,35)"/><circle cx="193" cy="240" r="5" fill="rgb(15,10,10)"/>
    <ellipse cx="319" cy="240" rx="34" ry="15" fill="rgb(240,235,230)"/><circle cx="319" cy="240" r="11" fill="rgb(70,50,35)"/><circle cx="319" cy="240" r="5" fill="rgb(15,10,10)"/>
    <line x1="153" y1="207" x2="233" y2="203" stroke="rgb(60,40,28)" stroke-width="9"/>
    <line x1="279" y1="203" x2="359" y2="207" stroke="rgb(60,40,28)" stroke-width="9"/>
    <line x1="256" y1="250" x2="248" y2="322" stroke="rgb(180,135,110)" stroke-width="7"/>
    <ellipse cx="256" cy="325" rx="24" ry="10" fill="rgb(170,120,100)"/>
    <path d="M206 376 Q256 408 306 376 Z" fill="rgb(160,70,80)"/>
  </g>
</svg>`;

/** A 512×512 soft drawing of a face, as raw RGB, laid out like an aligned crop (landmarks at FACE_TEMPLATE). */
export async function syntheticFace() {
  const { data, info } = await sharp(Buffer.from(SVG)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
