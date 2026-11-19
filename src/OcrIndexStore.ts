/**
 * This device's image and PDF text index in IndexedDB (docs/design-ocr-index-per-device.md §5.8 step B): outside the
 * vault, so no sync carries it and no other device writes it. One database per vault (`app.appId` in the name), store
 * `entries` (key = path), and `meta` for the one-time import of the old `ocr-index` folder.
 */
const ENTRIES = 'entries';
const META = 'meta';
const MIGRATED = 'migrated';

export const indexDbName = (appId: string) => `enhanced-canvas-ocr-${appId}`;

export class OcrIndexStore<T> {
    private constructor(private db: IDBDatabase) {
        // Our own deleteDatabase (the setting turned off) or a newer version elsewhere: let it through. Later writes fail.
        db.onversionchange = () => db.close();
    }

    /** Opens (or creates) the database; rejects where IndexedDB is unavailable. */
    static open<T>(name: string): Promise<OcrIndexStore<T>> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(name, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(ENTRIES);
                req.result.createObjectStore(META);
            };
            req.onsuccess = () => resolve(new OcrIndexStore<T>(req.result));
            req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
            req.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });
    }

    /** Deletes the database. Close every connection first, or it waits for them. */
    static delete(name: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
            req.onblocked = () => resolve(); // finishes once the other connection closes
        });
    }

    close() { this.db.close(); }

    /**
     * Every entry, and whether the old index was imported already. A cursor, not getAll(): the store can be ~100 MB,
     * and one getAll() returns it in a single message (Chromium caps those) instead of in batches.
     */
    readAll(): Promise<{ entries: Record<string, T>; migrated: boolean }> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([ENTRIES, META], 'readonly');
            const entries: Record<string, T> = {};
            const cursor = tx.objectStore(ENTRIES).openCursor();
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (!c) return;
                if (typeof c.key === 'string') entries[c.key] = c.value;
                c.continue();
            };
            const migrated = tx.objectStore(META).get(MIGRATED);
            tx.oncomplete = () => resolve({ entries, migrated: migrated.result === true });
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
    }

    /**
     * One transaction, so all or nothing: empties `entries` first if `clear`, then puts and deletes; `migrated` records
     * the import with them. Resolves once committed.
     */
    write(puts: [string, T][], dels: string[], opts: { clear?: boolean; migrated?: boolean } = {}): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([ENTRIES, META], 'readwrite');
            const store = tx.objectStore(ENTRIES);
            if (opts.clear) store.clear();
            for (const [k, v] of puts) store.put(v, k);
            for (const k of dels) store.delete(k);
            if (opts.migrated) tx.objectStore(META).put(true, MIGRATED);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
    }
}
