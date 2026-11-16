// Virtual modules from the `ocr-sources` plugin in esbuild.config.mjs.
// The bundled text of src/ocr-worker.js (WebGPU build of onnxruntime-web, which also runs WASM-only).
declare module 'ocr-worker-source' {
    const source: string;
    export default source;
}
// onnxruntime's ort-wasm-simd-threaded.asyncify.wasm, gzip-compressed and base64-encoded.
declare module 'ocr-wasm-source' {
    const source: string;
    export default source;
}
