// Regenerates build/icon.png (the source for the Windows .ico, macOS .icns and Linux icons).
//   npm run icon
import path from "node:path";
import sharp from "sharp";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b6cff"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="url(#g)"/>
  <path d="M10 9v14h12" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M15 14.5v4.5h4.5" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const out = path.resolve(import.meta.dirname, "..", "build", "icon.png");
await sharp(Buffer.from(svg), { density: 72 }).resize(1024, 1024).png({ compressionLevel: 9 }).toFile(out);
console.log(`wrote ${out}`);
