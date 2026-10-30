// Hash router: #/library, #/words, #/notes, #/settings, #/read/<docId>[/<page>]
const handlers = [];

export function navigate(hash, { replace = false } = {}) {
  if (location.hash === hash) return route();
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
  if (replace) route();
}

export function onRoute(fn) {
  handlers.push(fn);
}

export function parse(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const view = parts[0] || "library";
  return { view, args: parts.slice(1) };
}

export function route() {
  const r = parse();
  handlers.forEach((h) => h(r));
}

window.addEventListener("hashchange", route);
