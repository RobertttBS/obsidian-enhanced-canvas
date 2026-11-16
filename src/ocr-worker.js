// OCR Worker for the built-in OCR (src/BuiltinOcr.ts). Plain JS on purpose: tsconfig's `moduleResolution: "node"`
// can't resolve `ppu-paddle-ocr/web`, and nothing .ts imports this file, so tsc never sees these packages.
// Bundled to a string, against onnxruntime-web/webgpu, by the `ocr-sources` plugin in esbuild.config.mjs and
// started from a Blob URL. That one build also runs WASM-only, with the same asyncify .wasm and .onnx models.
import * as ort from 'onnxruntime-web';
import { PaddleOcrService } from 'ppu-paddle-ocr/web';

let service = null;

// ppu-paddle-ocr creates the detection and recognition sessions in parallel, and the WebGPU provider refuses a
// second session while one is being created (the library then silently puts that one on WASM). One at a time.
const createSession = ort.InferenceSession.create.bind(ort.InferenceSession);
let creating = Promise.resolve();
ort.InferenceSession.create = (...args) => {
    const session = creating.then(() => createSession(...args));
    creating = session.catch(() => {});
    return session;
};

self.onmessage = async ({ data }) => {
    if (data.type === 'init') {
        try {
            ort.env.wasm.wasmBinary = data.wasm;
            ort.env.wasm.numThreads = 1;
            // ppu-paddle-ocr/web points this at jsDelivr on import; while it is set, onnxruntime imports its
            // glue module from there on every start. Cleared, it uses the bundled glue + wasmBinary: no network.
            ort.env.wasm.wasmPaths = undefined;
            // data.gpu: try WebGPU. Without navigator.gpu (no adapter API at all, e.g. hardware acceleration off on
            // some systems) go straight to WASM instead of letting the library try and fall back.
            const gpu = !!data.gpu && !!self.navigator.gpu;
            const fellBack = [];
            service = new PaddleOcrService({
                model: { detection: data.det, recognition: data.rec, charactersDictionary: data.dict },
                // per-line (the default) merges boxes on one row: a tall box around vertical margin text swallows
                // the whole region, and the merged crop is then dropped for low confidence.
                recognition: { strategy: 'per-box' },
                session: { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], onSessionFallback: (e) => fellBack.push(String(e)) },
            });
            await service.initialize();
            self.postMessage({ type: 'ready', isolated: self.crossOriginIsolated, threads: ort.env.wasm.numThreads, gpu, fellBack });
        } catch (e) {
            self.postMessage({ type: 'init-error', error: String((e && e.stack) || e) });
        }
        return;
    }
    if (data.type === 'ocr') {
        const t = performance.now();
        try {
            // Decoded once here only for the size: boxes come back in pixels and the index stores fractions.
            // Same call as ppu-ocv's web loadImage (default imageOrientation, EXIF applied), so this size and the
            // boxes describe the same upright image, which is also how Obsidian's <img> shows it.
            const bitmap = await createImageBitmap(new Blob([data.bytes]));
            const size = [bitmap.width, bitmap.height];
            bitmap.close();
            const r = await service.recognize(data.bytes, { flatten: true });
            self.postMessage({ type: 'result', id: data.id, size, items: r.results.map((i) => ({ text: i.text, box: i.box })), ms: performance.now() - t });
        } catch (e) {
            self.postMessage({ type: 'ocr-error', id: data.id, error: String((e && e.stack) || e) });
        }
    }
};
