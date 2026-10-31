// Runs the Kokoro neural text-to-speech model off the main thread so reading
// and page turns stay smooth while audio is generated. Requests are handled
// one at a time (the model can't run two generations at once).
let tts = null;
let chain = Promise.resolve();
const cancelled = new Set();

self.onmessage = ({ data }) => {
  if (data.type === "load") return load(data);
  if (data.type === "cancel") { (data.ids || []).forEach((id) => cancelled.add(id)); return; }
  if (data.type === "say") chain = chain.then(() => say(data));
};

async function load(data) {
  let lastError = null;
  for (const url of data.urls) {
    try {
      const mod = await import(url);
      const KokoroTTS = mod.KokoroTTS || mod.default?.KokoroTTS;
      if (!KokoroTTS) throw new Error("KokoroTTS not found in " + url);
      tts = await KokoroTTS.from_pretrained(data.model, {
        dtype: data.dtype,
        device: data.device,
        progress_callback: (p) => self.postMessage({ type: "progress", p: { status: p?.status, file: p?.file, loaded: p?.loaded, total: p?.total } }),
      });
      self.postMessage({ type: "ready" });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  self.postMessage({ type: "error", error: String(lastError?.message || lastError || "Could not load the voice") });
}

async function say(data) {
  if (cancelled.delete(data.id)) return;
  try {
    if (!tts) throw new Error("Voice not loaded");
    const t0 = performance.now();
    const audio = await tts.generate(data.text, { voice: data.voice, speed: data.speed });
    const pcm = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
    self.postMessage({ type: "audio", id: data.id, pcm, rate: audio.sampling_rate || 24000, ms: performance.now() - t0 }, [pcm.buffer]);
  } catch (e) {
    self.postMessage({ type: "audio-error", id: data.id, error: String(e?.message || e) });
  }
}
