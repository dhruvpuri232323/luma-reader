// Test stand-in for the Kokoro voice model: same API, produces a quiet tone
// whose length follows the text, so the whole read-aloud pipeline (worker,
// download progress, audio playback, highlighting) can be tested offline.
export class KokoroTTS {
  static async from_pretrained(id, opts = {}) {
    for (let i = 1; i <= 4; i++) {
      opts.progress_callback?.({ status: "progress", file: "model_quantized.onnx", loaded: i * 25, total: 100 });
      await new Promise((r) => setTimeout(r, 60));
    }
    return new KokoroTTS();
  }

  async generate(text, { speed = 1 } = {}) {
    const secs = Math.min(0.9, 0.012 * text.length) / speed;
    const n = Math.max(2400, Math.round(24000 * secs));
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) audio[i] = Math.sin(i / 9) * 0.02;
    return { audio, sampling_rate: 24000 };
  }
}
