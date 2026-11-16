import type { TFile } from 'obsidian';
import wasmSource from 'ocr-wasm-source';
import workerSource from 'ocr-worker-source';
import type EnhancedCanvas from '../main';
import type { OcrLine } from './ImageTextSearch';
import { OcrAssets } from './OcrAssets';

/**
 * The built-in OCR (docs/spec-builtin-ocr.md): PaddleOCR (PP-OCRv6 small, onnxruntime-web, single thread) in a
 * Web Worker (src/ocr-worker.js), on WebGPU when available, else WASM. ImageTextSearch.ocrImages() uses it instead of
 * the system OCR on Linux, or on Windows when the device-local engine choice is 'builtin'. The model files come from
 * OcrAssets; the onnxruntime .wasm ships inside main.js (`ocr-wasm-source`). Only obsidian and browser APIs here: no
 * Node modules (mobile loads this file too).
 */
const INIT_TIMEOUT = 60_000;
const IMAGE_TIMEOUT = 90_000;
const GPU_BATCH = 50; // same as the system OCR
const WASM_BATCH = 10; // ~7 s per image on WASM: 50 would save progress only every ~6 minutes
const LOG = 'Enhanced Canvas OCR (built-in):';

type Box = { x: number; y: number; width: number; height: number };
type Result = { type: 'result'; id: number; size: [number, number]; items: { text: string; box: Box }[]; ms: number };
type Reply =
    | { type: 'ready'; isolated: boolean; threads: number; gpu: boolean; fellBack: string[] }
    | { type: 'init-error'; error: string }
    | Result
    | { type: 'ocr-error'; id: number; error: string };
/** A reply, 'timeout', or null: the worker errored or was disposed. */
type Outcome = Reply | 'timeout' | null;

/** The 'gzip' DecompressionStream (Electron has it; TypeScript 4.7's DOM lib doesn't declare it). */
declare const DecompressionStream: { new (format: 'gzip'): TransformStream<Uint8Array, Uint8Array> };

/** The bundled onnxruntime .wasm, decompressed. A fresh buffer per call: the worker takes it by transfer. */
async function unpackWasm(): Promise<ArrayBuffer> {
    const bin = atob(wasmSource);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export class BuiltinOcr {
    readonly assets = new OcrAssets();
    private worker: Worker | null = null;
    private isolated = false;
    private threads = 1;
    private ep: string | null = null; // what the running (or last) worker uses, for the log line and batch size
    private gpu = true; // try WebGPU; false for the rest of this Obsidian run after the GPU worker failed twice
    private gpuFailures = 0; // GPU worker failures in a row (init or the restart path)
    private nextId = 0;
    // One request is in flight at a time: its resolver, and the image id it waits for (none for init).
    private settle: ((r: Outcome) => void) | null = null;
    private expect: number | undefined;

    constructor(private plugin: EnhancedCanvas) {}

    /** Images per batch: fewer on WASM, so progress is saved every minute or so. */
    get batchSize(): number {
        const gpu = this.ep !== null ? this.ep.startsWith('webgpu') : this.gpu && 'gpu' in navigator;
        return gpu ? GPU_BATCH : WASM_BATCH;
    }

    /** Same contract as ImageTextSearch.ocrImages(): one entry per file (null = unreadable), or null if the batch failed. */
    async read(files: TFile[], alive: () => boolean): Promise<(OcrLine[] | null)[] | null> {
        const t0 = performance.now();
        const times: number[] = [];
        let init = 0;
        try {
            const out: (OcrLine[] | null)[] = [];
            for (const file of files) {
                if (!alive()) return null;
                let bytes: ArrayBuffer;
                try {
                    bytes = await this.plugin.app.vault.readBinary(file);
                } catch (e) {
                    console.warn(LOG, file.path, e);
                    out.push(null);
                    continue;
                }
                if (!alive()) return null;
                if (!this.worker) {
                    // A GPU init failure is retried at once: the second in a row switches to WASM (gpuFailed), which
                    // gets one more start. Otherwise a one-image batch would mark its image failed before WASM is tried.
                    let ms: number | null = null;
                    for (let tries = 0; tries < 3; tries++) {
                        const failures = this.gpuFailures;
                        ms = await this.start(alive);
                        if (ms !== null || this.gpuFailures === failures || !alive()) break;
                    }
                    if (ms === null) return null;
                    init += ms;
                }
                const worker = this.worker as Worker | null;
                if (!worker) return null; // disposed while starting
                const id = ++this.nextId;
                const reply = this.wait(IMAGE_TIMEOUT, id);
                worker.postMessage({ type: 'ocr', id, bytes }, [bytes]);
                const r = await reply;
                if (r && r !== 'timeout' && r.type === 'result') {
                    out.push(toLines(r));
                    times.push(r.ms);
                    this.gpuFailures = 0;
                } else if (r && r !== 'timeout' && r.type === 'ocr-error') {
                    console.warn(LOG, file.path, r.error);
                    out.push(null);
                } else {
                    if (!alive()) return null; // disposed by disable()/rebuild(): the worker may already be a new scan's
                    console.warn(LOG, file.path, r === 'timeout' ? 'timed out' : 'worker failed', '- restarting the worker');
                    this.gpuFailed(!!this.ep?.startsWith('webgpu'));
                    this.dispose(); // it may be stuck; the next image starts a new one
                    out.push(null);
                }
            }
            return out;
        } finally {
            const sorted = [...times].sort((a, b) => a - b);
            const median = sorted.length ? sorted[sorted.length >> 1] : 0;
            const max = sorted.length ? sorted[sorted.length - 1] : 0;
            console.info(`${LOG} ${files.length} images, ${times.length} read, ${((performance.now() - t0) / 1000).toFixed(1)} s total, median ${Math.round(median)} ms, max ${Math.round(max)} ms, init ${Math.round(init)} ms, crossOriginIsolated=${this.isolated}, threads=${this.threads}, ep=${this.ep}`);
        }
    }

    /** Terminates the worker and ends any pending read() step. Safe to call repeatedly; read() starts a new worker. */
    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.settle?.(null);
    }

    /** A GPU worker failed: the second time in a row, use WASM until Obsidian restarts (not persisted). */
    private gpuFailed(onGpu: boolean) {
        if (!onGpu || ++this.gpuFailures < 2) return;
        this.gpu = false;
        console.warn(LOG, 'the WebGPU worker failed twice in a row; using WASM until Obsidian restarts.');
    }

    /** Starts and initializes the worker; returns the milliseconds it took, or null on failure. */
    private async start(alive: () => boolean): Promise<number | null> {
        const t = performance.now();
        const models = await this.assets.load();
        if (!models) return null; // logged by load(); ImageTextSearch checks ready() before each scan
        let wasm: ArrayBuffer;
        try {
            wasm = await unpackWasm();
        } catch (e) {
            console.error(LOG, 'unpacking the bundled wasm failed:', e);
            return null;
        }
        if (!alive()) return null;
        let worker: Worker;
        try {
            const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
            try {
                worker = new Worker(url);
            } finally {
                URL.revokeObjectURL(url);
            }
        } catch (e) {
            console.error(LOG, 'creating the worker failed:', e);
            return null;
        }
        this.worker = worker;
        worker.onmessage = (e: MessageEvent<Reply>) => {
            if (this.worker !== worker) return;
            const r = e.data;
            if ('id' in r && r.id !== this.expect) return; // a late reply to an image that already timed out
            this.settle?.(r);
        };
        worker.onerror = (e: ErrorEvent) => {
            if (this.worker !== worker) return;
            console.error(LOG, 'worker error:', e.message);
            this.settle?.(null);
        };
        const reply = this.wait(INIT_TIMEOUT);
        const [det, rec, dict] = models;
        worker.postMessage({ type: 'init', gpu: this.gpu, wasm, det, rec, dict }, [wasm, det, rec, dict]);
        const r = await reply;
        if (this.worker !== worker) return null; // disposed meanwhile
        if (!r || r === 'timeout' || r.type !== 'ready') {
            console.error(LOG, 'init failed:', r === 'timeout' ? 'timed out' : r && r.type === 'init-error' ? r.error : 'worker error');
            this.gpuFailed(this.gpu && 'gpu' in navigator); // a broken driver may fail here rather than per image
            this.dispose();
            return null;
        }
        this.isolated = r.isolated;
        this.threads = r.threads;
        this.ep = !r.gpu ? 'wasm' : r.fellBack.length ? `webgpu (${r.fellBack.length} of 2 sessions fell back to wasm)` : 'webgpu';
        r.fellBack.forEach((e) => console.warn(LOG, 'a WebGPU session fell back to WASM:', e));
        return performance.now() - t;
    }

    /** Waits for the reply to the request about to be posted. Every path settles: reply, timeout, error or dispose(). */
    private wait(ms: number, id?: number): Promise<Outcome> {
        this.settle?.(null); // only one request at a time; never leave an earlier one hanging
        return new Promise((resolve) => {
            const finish = (r: Outcome) => {
                window.clearTimeout(timer);
                if (this.settle === finish) {
                    this.settle = null;
                    this.expect = undefined;
                }
                resolve(r);
            };
            const timer = window.setTimeout(() => finish('timeout'), ms);
            this.settle = finish;
            this.expect = id;
        });
    }
}

/** Pixel boxes → OcrLine fractions of the image, origin top left, clamped inside it. Empty text is skipped. */
function toLines({ size: [w, h], items }: Result): OcrLine[] {
    const lines: OcrLine[] = [];
    for (const { text, box } of items) {
        const t = text.trim();
        if (!t) continue;
        const x = clamp(box.x / w, 0, 1);
        const y = clamp(box.y / h, 0, 1);
        lines.push([t, x, y, clamp(box.width / w, 0, 1 - x), clamp(box.height / h, 0, 1 - y)]);
    }
    return lines;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
