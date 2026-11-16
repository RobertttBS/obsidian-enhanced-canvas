import { requestUrl } from 'obsidian';

/**
 * The built-in OCR's model data (docs/spec-builtin-ocr.md §4, §5.3): downloaded once from this project's GitHub
 * release, verified, and kept in IndexedDB (outside the vault, so file sync never carries 31 MB; the database name
 * has no vault id). Data only: the onnxruntime .wasm ships inside main.js. Browser and obsidian APIs only: mobile
 * loads this file too (and never calls it).
 */
const TAG = 'ocr-assets-1'; // a new model or onnxruntime gets a new tag; old plugin versions keep the old one
const BASE = `https://github.com/RobertttBS/obsidian-enhanced-canvas/releases/download/${TAG}`;
// In the order load() returns them: detection model, recognition model, dictionary.
const FILES = [
    { name: 'det.onnx', size: 9_880_512, sha256: 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e' },
    { name: 'rec.onnx', size: 21_159_378, sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634' },
    { name: 'dict.txt', size: 74_948, sha256: '41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8' },
];
const DB = 'enhanced-canvas-ocr-assets';
const STORE = 'files';
const LOG = 'Enhanced Canvas OCR (built-in):';

export type DownloadResult = 'ok' | 'network' | 'hash' | 'storage';

/** Total download size in bytes, for messages. */
export const ASSETS_BYTES = FILES.reduce((n, f) => n + f.size, 0);

const key = (name: string) => `${TAG}/${name}`;

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
}

/** Runs one request in its own transaction and resolves when that transaction completes (so a put is on disk). */
async function run<T>(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = make(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = () => reject(tx.error ?? req.error);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
    } finally {
        db.close();
    }
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export class OcrAssets {
    private isReady = false; // once true it stays true until clear(): reads never re-verify (§5.3)
    private downloading: Promise<DownloadResult> | null = null;

    /** All three files are stored (each was verified when written). */
    async ready(): Promise<boolean> {
        if (this.isReady) return true;
        try {
            const have = await this.stored();
            this.isReady = FILES.every((f) => have.has(f.name));
        } catch (e) {
            console.warn(LOG, 'reading IndexedDB failed:', e);
        }
        return this.isReady;
    }

    get isDownloading() { return this.downloading !== null; }

    /** det, rec, dict, in that order; null if one is missing or unreadable. */
    async load(): Promise<ArrayBuffer[] | null> {
        try {
            const bufs = await Promise.all(FILES.map((f) => run<ArrayBuffer | undefined>('readonly', (s) => s.get(key(f.name)))));
            if (bufs.every((b): b is ArrayBuffer => b instanceof ArrayBuffer)) return bufs;
            this.isReady = false; // cleared from outside (Obsidian's data cleared): download again
        } catch (e) {
            console.error(LOG, 'loading the model files failed:', e);
        }
        return null;
    }

    /**
     * Fetches the files not stored yet, one at a time, and stores each only if its SHA-256 matches. Resumes per file.
     * One download at a time: a call while one runs gets the same promise. onProgress reports bytes, per file.
     */
    download(onProgress: (done: number, total: number) => void): Promise<DownloadResult> {
        return this.downloading ??= this.fetchAll(onProgress).finally(() => { this.downloading = null; });
    }

    /** Deletes the whole database: this tag's files and any older tag's. */
    clear(): Promise<void> {
        this.isReady = false;
        return new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(DB);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            // Another window holds a connection: deletion finishes once it closes; nothing to wait for here.
            req.onblocked = () => resolve();
        });
    }

    /** Names of this tag's stored files. */
    private async stored(): Promise<Set<string>> {
        const keys = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
        const prefix = `${TAG}/`;
        return new Set(keys.flatMap((k) => (typeof k === 'string' && k.startsWith(prefix) ? [k.slice(prefix.length)] : [])));
    }

    private async fetchAll(onProgress: (done: number, total: number) => void): Promise<DownloadResult> {
        let have: Set<string>;
        try {
            have = await this.stored();
        } catch (e) {
            console.error(LOG, 'opening IndexedDB failed:', e);
            return 'storage';
        }
        let done = FILES.filter((f) => have.has(f.name)).reduce((n, f) => n + f.size, 0);
        onProgress(done, ASSETS_BYTES);
        for (const f of FILES) {
            if (have.has(f.name)) continue;
            let buf: ArrayBuffer;
            try {
                // requestUrl, not fetch: GitHub's release download redirects to a host without CORS headers.
                buf = (await requestUrl({ url: `${BASE}/${f.name}` })).arrayBuffer;
            } catch (e) {
                console.error(LOG, `downloading ${f.name} failed:`, e);
                return 'network';
            }
            const got = hex(await crypto.subtle.digest('SHA-256', buf));
            if (got !== f.sha256) {
                console.error(LOG, `${f.name}: SHA-256 ${got} (${buf.byteLength} bytes), expected ${f.sha256}`);
                return 'hash';
            }
            try {
                await run('readwrite', (s) => s.put(buf, key(f.name)));
            } catch (e) {
                console.error(LOG, `storing ${f.name} failed:`, e);
                return 'storage';
            }
            done += f.size;
            onProgress(done, ASSETS_BYTES);
        }
        this.isReady = true;
        return 'ok';
    }
}
