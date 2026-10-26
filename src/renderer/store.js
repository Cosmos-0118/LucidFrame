// Queue state. Plain reducer so every transition is easy to reason about.

export const initialState = { items: [], selectedId: null };

const fresh = (item) => ({ ...item, status: "queued", progress: null, result: null, error: null, startedAt: null, dims: item.dims ?? null });

export function reducer(state, action) {
  switch (action.type) {
    case "add": {
      const byId = new Map(state.items.map((i) => [i.id, i]));
      const added = [];
      for (const raw of action.items) {
        const existing = byId.get(raw.id);
        if (existing) {
          // Dropping a finished file again means "do it again".
          if (existing.status !== "running" && existing.status !== "queued") byId.set(raw.id, { ...fresh(existing), sourceUrl: raw.sourceUrl });
        } else {
          byId.set(raw.id, fresh(raw));
          added.push(raw.id);
        }
      }
      const items = [...byId.values()];
      return { items, selectedId: added[0] ?? state.selectedId ?? items[0]?.id ?? null };
    }
    case "remove": {
      const items = state.items.filter((i) => i.id !== action.id);
      return { items, selectedId: state.selectedId === action.id ? (items[0]?.id ?? null) : state.selectedId };
    }
    case "clear":
      return { items: state.items.filter((i) => i.status === "running"), selectedId: state.items.find((i) => i.status === "running")?.id ?? null };
    case "select":
      return { ...state, selectedId: action.id };
    case "dims":
      return patch(state, action.id, (i) => (i.dims ? i : { ...i, dims: { w: action.w, h: action.h } }));
    case "requeue":
      return patch(state, action.id, (i) => fresh(i));
    case "start":
      return patch(state, action.id, (i) => ({ ...i, status: "running", error: null, result: null, progress: { fraction: 0, message: "Starting…" }, startedAt: Date.now() }));
    case "progress":
      return patch(state, action.id, (i) => {
        if (i.status !== "running") return i;
        const { fraction = 0, etaSeconds = null, message, phase, frame, frames, fps } = action.data;
        let eta = etaSeconds;
        if (eta == null && fraction > 0.04 && i.startedAt) eta = ((Date.now() - i.startedAt) / 1000) * ((1 - fraction) / fraction);
        return { ...i, progress: { fraction, etaSeconds: eta, message: message ?? (fraction >= 0.92 && phase === "encode" ? "Saving…" : null), phase, frame, frames, fps } };
      });
    case "done":
      return patch(state, action.id, (i) => ({ ...i, status: "done", progress: null, result: action.result, error: null }));
    case "error":
      return patch(state, action.id, (i) => ({ ...i, status: "error", progress: null, error: action.message }));
    case "cancelled":
      return patch(state, action.id, (i) => ({ ...i, status: "cancelled", progress: null }));
    default:
      return state;
  }
}

function patch(state, id, fn) {
  return { ...state, items: state.items.map((i) => (i.id === id ? fn(i) : i)) };
}
