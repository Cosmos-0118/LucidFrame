export const defaultBackend = "http://localhost:8000";

export const cleanUrl = (url) => url.trim().replace(/\/$/, "");

export const getStored = (key, fallback) =>
  localStorage.getItem(key) || fallback;
