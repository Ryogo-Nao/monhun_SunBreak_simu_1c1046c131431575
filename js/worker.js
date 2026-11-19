import { simulate } from "./solver.js";

self.onmessage = (e) => {
  const input = e.data;
  try {
    // Infinity は structured clone で保持されるが念のため null も無制限扱い
    input.decos = input.decos.map((d) => ({ ...d, count: d.count == null ? Infinity : d.count }));
    input.opts.onProgress = (p) => self.postMessage({ type: "progress", ...p });
    const out = simulate(input);
    self.postMessage({ type: "done", out });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.stack || err) });
  }
};
