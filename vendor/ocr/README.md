On-device text recognition for scanned PDFs.

- `tesseract-core-*-lstm.js/.wasm` — Tesseract 5 compiled to WebAssembly, from
  [tesseract.js-core](https://github.com/naptha/tesseract.js-core) v5.1.1 (Apache-2.0).
  The SIMD build is used where the browser supports it.
- `eng.traineddata.gz` — the fast English model from
  [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) (Apache-2.0), gzipped.
