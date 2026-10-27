"""Pull a fixed, reproducible sample of ground-truth faces out of an FFHQ-512 Arrow shard (benchmark use only)."""
import io, sys
from pathlib import Path
import pyarrow as pa
from PIL import Image

shard, out, n = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
with pa.memory_map(str(shard)) as src:
    try:
        table = pa.ipc.open_stream(src).read_all()
    except pa.ArrowInvalid:
        table = pa.ipc.open_file(src).read_all()
print(table.schema.names, table.num_rows)
col = next(c for c in table.schema.names if "image" in c.lower())
step = max(1, table.num_rows // n)  # evenly spaced, deterministic
for k, i in enumerate(range(0, table.num_rows, step)):
    if k >= n:
        break
    cell = table[col][i].as_py()
    img = Image.open(io.BytesIO(cell["bytes"])).convert("RGB")
    if img.size != (512, 512):
        img = img.resize((512, 512), Image.LANCZOS)
    img.save(out / f"ffhq_{k:03d}.png")
print("wrote", len(list(out.glob("*.png"))))
