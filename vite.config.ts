import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The sound files that actually ship in public/audio/, by name. The page asks
 * only for these, so an optional cue nobody supplied is never fetched — on a
 * hosted deploy every such miss was a 404 in the console and a request to the
 * server.
 */
const AUDIO_FILES = (() => {
  try {
    return readdirSync(fileURLToPath(new URL('./public/audio', import.meta.url)))
      .filter((f) => f.endsWith('.mp3'))
      .map((f) => f.slice(0, -4))
  } catch {
    return []
  }
})()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __MEBO_AUDIO_FILES__: JSON.stringify(AUDIO_FILES) },
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set MEBO_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    // onnxruntime-web is excluded for the same reason: it locates its .wasm
    // with `new URL(..., import.meta.url)`, which pre-bundling relocates.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers', 'onnxruntime-web'],
  },
  // The Piper worker (src/lib/piper.worker.ts) imports onnxruntime-web, which
  // loads its WASM glue with a dynamic import — only an ES-module worker can.
  worker: { format: 'es' },
})
