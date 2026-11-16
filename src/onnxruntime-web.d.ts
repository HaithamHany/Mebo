/**
 * onnxruntime-web ships its types as an ambient `declare module` file, but its
 * package `exports` map has no `types` condition, so TypeScript's bundler
 * resolution cannot find them. This mirrors that file. Types only — the
 * runtime import is resolved by Vite as usual.
 */
declare module 'onnxruntime-web' {
  export * from 'onnxruntime-common'
}
