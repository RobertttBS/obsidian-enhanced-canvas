import { ButtonComponent, EventRef, FileSystemAdapter, Modal, Notice, Platform, Setting, SuggestModal, TAbstractFile, TFile, loadPdfJs, setIcon } from 'obsidian';
import type { ChildProcess } from 'child_process';
import { around } from 'monkey-around';

import EnhancedCanvas from '../main';
import type { CanvasView } from '../Canvas';
import { matchesTextQuery, normalizeText, parseTextQuery, queryTerms } from './utils';

const IMAGE_EXT = /^(png|jpe?g|heic|webp|gif|tiff?|bmp)$/i;
const BATCH = 50; // files per OCR process run; keeps argv short and saves progress often
const PDF_BATCH = 5; // at most this many PDFs per batch: a large one takes seconds, and progress is saved per batch
const DEVICE_KEY = 'enhanced-canvas-ocr-device'; // localStorage (per vault, per device): `failed` and `readImage`
const PAGE = 50; // results the modal shows at first, and adds per "Show more"
const COMMAND_ID = 'search-image-text';
const REBUILD_ID = 'rebuild-image-text-index';
const UNLOCK_ID = 'unlock-pdfs-for-text-search';
const SHARDS = 64; // index files; a save rewrites only the shards that changed
// FNV-1a over UTF-16 code units. Must never change: it decides which file holds a path.
const shardOf = (path: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
    return (h >>> 0) % SHARDS;
};

/** Image: [text, x, y, w, h], box normalized to the image, origin top-left. PDF: [text, page], page 1-based. */
export type OcrLine = [string, number, number, number, number] | [string, number];
/**
 * `pw`: a PDF that needs a password. 'locked' = not read yet (`l` is empty); 'unlocked' = read with a password
 * the user typed in PdfUnlockModal, which isn't kept anywhere, so Rebuild keeps this entry instead of re-reading it.
 */
type OcrEntry = { m: number; l: OcrLine[]; pw?: 'locked' | 'unlocked' };
type OcrIndex = Record<string, OcrEntry>;

export const isImageFile = (f: TAbstractFile | null): f is TFile => f instanceof TFile && IMAGE_EXT.test(f.extension);
/** Files in the index: images (OCR) and PDFs (their embedded text layer only; scanned pages stay unsearchable). */
const isPdf = (f: TFile) => f.extension.toLowerCase() === 'pdf';
const isIndexedFile = (f: TAbstractFile | null): f is TFile => isImageFile(f) || (f instanceof TFile && isPdf(f));

// macOS's built-in JavaScript for Automation calls Vision.framework (runs on the Neural
// Engine). Nothing to ship or install: osascript is on every Mac. PDFs don't go through it: see readPdf.
const OCR_SCRIPT = `ObjC.import('Vision');
function run(paths) {
  return JSON.stringify(paths.map(function (p) {
    try {
      var req = $.VNRecognizeTextRequest.alloc.init;
      req.recognitionLevel = 0; // accurate
      req.usesLanguageCorrection = true;
      // macOS 13+; older systems keep Vision's default languages.
      if (req.respondsToSelector('setAutomaticallyDetectsLanguage:')) req.automaticallyDetectsLanguage = true;
      var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(p), $({}));
      if (!handler.performRequestsError($([req]), null)) return null; // unreadable image, not "no text"
      var res = req.results, lines = [];
      for (var i = 0; i < res.count; i++) {
        var o = res.objectAtIndex(i), c = o.topCandidates(1), b = o.boundingBox;
        if (c.count) lines.push([c.objectAtIndex(0).string.js, b.origin.x, 1 - b.origin.y - b.size.height, b.size.width, b.size.height]);
      }
      return lines;
    } catch (e) { return null; } // script error, not "no text": the caller must not index it as empty
  }));
}`;

// Windows 10/11: Windows.Media.Ocr through Windows PowerShell 5.1 (powershell.exe, on every install;
// PowerShell 7 can't load WinRT types). Reads the paths as JSON on stdin, writes the same JSON shape as
// OCR_SCRIPT. Exit 2 = no OCR language installed; exit 3 = Constrained Language Mode (AppLocker/WDAC), where
// the .NET calls below are blocked — checked first, before anything that mode forbids. Both set `broken`.
// Engine: the user's first Chinese/Japanese/Korean language (Settings order) that has OCR, else the first installed
// CJK OCR language (system order, not the user's), else the first user-profile one. One engine
// reads one language; a CJK engine still reads Latin text, an English one drops every CJK character silently.
// JSON is written by hand: ConvertTo-Json in 5.1 can wrap arrays in {"value":…,"Count":…}.
// PowerShell variable names are case-insensitive: $w would overwrite $W, so the word loop uses $wd.
const WIN_OCR_SCRIPT = `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 3 }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(-1); $task.Result }
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.System.UserProfile.GlobalizationPreferences, Windows.System.UserProfile, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$cjk = @([Windows.System.UserProfile.GlobalizationPreferences]::Languages | Where-Object { $_ -match '^(zh|ja|ko)' } | ForEach-Object { New-Object Windows.Globalization.Language $_ } | Where-Object { [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($_) }) + @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.LanguageTag -match '^(zh|ja|ko)' }) | Select-Object -First 1
$engine = if ($cjk) { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($cjk) } else { [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { [Console]::Error.Write('No OCR language installed.'); exit 2 }
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$inv = [Globalization.CultureInfo]::InvariantCulture
function N($v) { ([double]$v).ToString('R', $inv) }
$paths = ConvertFrom-Json ([Console]::In.ReadToEnd()) # assigned first: 5.1 emits the array as one object, so @(...) would nest it
$out = foreach ($p in $paths) {
  $fs = $null; $b = $null
  try {
    $fs = [IO.File]::OpenRead($p)
    $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync([IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fs))) ([Windows.Graphics.Imaging.BitmapDecoder])
    $k = [Math]::Min(1.0, $max / [Math]::Max($d.PixelWidth, $d.PixelHeight)) # larger images are rejected
    $tr = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tr.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($d.PixelWidth * $k))
    $tr.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($d.PixelHeight * $k))
    $b = Await ($d.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tr, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $r = Await ($engine.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
    $W = $b.PixelWidth; $H = $b.PixelHeight
    $ls = foreach ($l in $r.Lines) {
      $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0.0; $y1 = 0.0
      foreach ($wd in $l.Words) { $q = $wd.BoundingRect; $x0 = [Math]::Min($x0, $q.X); $y0 = [Math]::Min($y0, $q.Y); $x1 = [Math]::Max($x1, $q.X + $q.Width); $y1 = [Math]::Max($y1, $q.Y + $q.Height) }
      '[' + (ConvertTo-Json ([string]$l.Text)) + ',' + (N ($x0 / $W)) + ',' + (N ($y0 / $H)) + ',' + (N (($x1 - $x0) / $W)) + ',' + (N (($y1 - $y0) / $H)) + ']'
    }
    '[' + ($ls -join ',') + ']'
  } catch { 'null' } finally { if ($b) { $b.Dispose() }; if ($fs) { $fs.Dispose() } }
}
[Console]::Out.Write('[' + ($out -join ',') + ']')`;
// Formats every OCR backend can decode. Windows needs Store codecs for HEIC (HEIF Image Extensions, not
// preinstalled) and WebP (may be removed on LTSC/debloated systems): only these formats can tell "OCR is broken".
const ALWAYS_DECODABLE = /^(png|jpe?g|gif|tiff?|bmp)$/i;
const NEEDS_CODEC = /^(heic|webp)$/i;

/** Why image OCR can't run at all, as opposed to one image failing. Each pauses image reading until Rebuild. */
type OcrBlock = 'no-language' | 'constrained' | 'blocked' | 'stopped' | 'missing';
const BLOCK_HINT: Record<OcrBlock, string> = {
    'no-language': 'Windows has no OCR language installed. Add one in Settings → Time & language → Language & region: pick a language → Language options → Optical character recognition.',
    'constrained': 'PowerShell runs in Constrained Language Mode, set by your organization\'s security policy (AppLocker or WDAC), which blocks Windows OCR. Only your IT administrator can allow it. PDFs are still indexed.',
    'blocked': 'PowerShell was blocked or stopped, most likely by antivirus or a company security policy. Allow powershell.exe for Obsidian, or ask your IT administrator. PDFs are still indexed.',
    'stopped': 'PowerShell kept closing without an error message, which usually means antivirus or endpoint security (EDR) stopped it. Allow powershell.exe for Obsidian, or ask your IT administrator. PDFs are still indexed.',
    'missing': 'Windows PowerShell (powershell.exe) wasn\'t found on this system. PDFs are still indexed.',
};
// AMSI (Defender and most antivirus) refusing the script text.
const AV_BLOCKED = /ScriptContainedMaliciousContent|malicious content|antivirus/i;

/**
 * A Windows path PowerShell 5.1 can open past MAX_PATH (260) without LongPathsEnabled: `\\?\C:\…` or `\\?\UNC\server\…`.
 * Shorter paths are left alone. `\\?\` turns off normalization, so the path is resolved first (backslashes, no `.`/`..`).
 */
function longPath(p: string) {
    if (p.length < 260 || p.startsWith('\\\\?\\')) return p;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const full = (require('path') as typeof import('path')).win32.resolve(p);
    return full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
}

// Windows OCR puts a space between CJK characters; drop it so "中文" matches.
const CJK_GAP = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯])/gu;

/**
 * Optional: on macOS or Windows desktop, OCR every vault image into an index kept in the plugin
 * folder (no notes are created); on every device, a vault-wide "Search text in images and PDFs"
 * modal and image matches for Find in canvas. Other devices only read the synced index.
 */
export class ImageTextSearch {
    index: OcrIndex = {};
    private enabled = false;
    private refs: EventRef[] = [];
    private ribbon: HTMLElement | null = null;
    private proc: ChildProcess | null = null;
    private scanning = false;
    private rescan = false;
    private gen = 0; // bumped by disable(), so a scan can tell its OCR process was killed on purpose
    private failed = new Map<string, number>(); // path → mtime this device couldn't read; retried once the file changes or on Rebuild
    private readImage = false; // this device has read an image, so OCR works here (index entries may come from another device)
    private broken = false; // image OCR itself failed: images are skipped until Rebuild, so each change doesn't burn a new batch
    private blockedBy: OcrBlock | null = null; // the known reason for `broken`, shown in the notice
    private silentRuns = 0; // Windows runs in a row that failed with no error text and weren't killed by us: a likely EDR kill
    private pdfLockChecked = false; // earlier builds indexed a locked PDF as empty: the first scan re-reads empty PDFs once
    private saving: Promise<void> = Promise.resolve();
    private saveQueued = false;
    private loadedAt: number[] = []; // per shard: mtime of the file last read or written
    private dirty = new Set<number>(); // shards changed since the last save

    constructor(readonly plugin: EnhancedCanvas) {}

    /** Only macOS and Windows desktop read images; other devices search the index that sync brings over. */
    static get canIndex() { return (Platform.isMacOS || Platform.isWin) && Platform.isDesktopApp; }

    get isEnabled() { return this.enabled; }

    /** True while images are still being read, so a search may miss some. */
    get isIndexing() { return this.scanning; }

    private get indexDir() { return `${this.plugin.manifest.dir}/ocr-index`; }
    private shardPath(s: number) { return `${this.indexDir}/${s.toString(16).padStart(2, '0')}.json`; }

    /** The only way to change one entry: it marks the entry's shard for the next save. */
    private put(path: string, entry?: OcrEntry) {
        if (entry) this.index[path] = entry; else delete this.index[path];
        this.dirty.add(shardOf(path));
    }

    register() {
        this.plugin.register(() => this.disable());
        // Patched always; the hooks do nothing unless the feature and imageTextInCoreSearch are on.
        this.plugin.registerLazyPatcher(() => this.patchCoreSearch());
        if (this.plugin.settings.enableImageTextSearch) void this.enable();
    }

    get inCoreSearch() { return this.enabled && this.plugin.settings.imageTextInCoreSearch; }

    private open = () => void this.refresh().then(() => { if (this.enabled) new ImageTextModal(this).open(); });

    /** Reruns open core searches, so image results follow imageTextInCoreSearch. */
    setCoreSearch() {
        for (const leaf of this.plugin.app.workspace.getLeavesOfType('search')) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const view = leaf.view as any;
            if (!view.getQuery?.()) continue;
            view.searchQuery = null; // else the same query only rechecks files the last run matched
            view.startSearch?.();
        }
    }

    /**
     * Core Search reads only .md/.canvas content, so images match by filename alone. Undocumented
     * internals (checked on 1.15.1): the query's match(file, content) gets an image's OCR text as
     * if it were a note, and the result list's addResult gets it too, to render the matched lines.
     * Missing methods → no patch, Search works as before.
     */
    private patchCoreSearch() {
        // A deferred (not yet shown) leaf has no startSearch; take the first loaded one.
        const view = this.plugin.app.workspace.getLeavesOfType('search')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((l) => l.view as any)
            .find((v) => typeof v?.startSearch === 'function' && typeof v.dom?.addResult === 'function');
        if (!view) return false;
        const ocr = (f: TFile) => {
            const t = this.inCoreSearch && isIndexedFile(f) ? this.textOf(f.path) : null;
            return t ? t.lines.map((l) => l[0]).join('\n') : null;
        };
        const { plugin } = this;
        const active = () => this.inCoreSearch;
        const refresh = () => { if (active()) void this.refresh(); };
        plugin.register(around(Object.getPrototypeOf(view.dom), {
            addResult: (next) => function (this: unknown, file: TFile, result: unknown, content: string, ...rest: unknown[]) {
                const t = ocr(file);
                const item = next.call(this, file, result, t ?? content, ...rest);
                // Core shows no image preview; add one between the title and the matched lines.
                if (t !== null && isImageFile(file) && item?.selfEl instanceof HTMLElement && !item.selfEl.nextElementSibling?.matches('.ec-search-thumb')) {
                    item.selfEl.after(createEl('img', {
                        cls: 'ec-search-thumb', attr: { src: plugin.app.vault.getResourcePath(file), loading: 'lazy' },
                    }));
                }
                return item;
            },
        }));
        let queryPatched = false;
        plugin.register(around(view.constructor.prototype, {
            startSearch: (next) => function (this: typeof view, ...args: unknown[]) {
                refresh(); // search-only devices: pick up a synced index for the next search
                const r = next.apply(this, args);
                // The query class is reachable only through a query, which the first search creates.
                const proto = this.searchQuery && Object.getPrototypeOf(this.searchQuery);
                if (queryPatched || typeof proto?.match !== 'function') return r;
                queryPatched = true;
                plugin.register(around(proto, {
                    match: (m) => function (this: unknown, file: TFile, content: string) {
                        const t = ocr(file);
                        return t === null ? m.call(this, file, content)
                            : m.call(this, Object.create(file, { extension: { value: 'md' } }), t);
                    },
                }));
                if (!active()) return r;
                this.searchQuery = null; // a repeated query only rechecks the last run's matches
                return next.apply(this, args); // rerun the first search with the patch
            },
        }));
        // A search that ran before this patch (a deferred tab shown, or startup) has no image results yet.
        if (active()) this.setCoreSearch();
        return true;
    }

    async enable() {
        if (this.enabled) return;
        this.enabled = true;
        const { app } = this.plugin;
        const gen = this.gen;
        await this.load();
        // Turned off while reading (and maybe on again: that later call does the setup).
        if (gen !== this.gen) return;
        if (ImageTextSearch.canIndex) this.loadDevice();

        this.plugin.addCommand({ id: COMMAND_ID, name: 'Search text in images and PDFs', callback: this.open });
        this.ribbon = this.plugin.addRibbonIcon('scan-text', 'Search text in images and PDFs', this.open);
        this.setCoreSearch();
        // Search-only devices never write the index: the indexing computer owns the file.
        if (!ImageTextSearch.canIndex) return;
        this.plugin.addCommand({ id: REBUILD_ID, name: 'Rebuild image and PDF text index', callback: () => void this.rebuild() });
        this.plugin.addCommand({ id: UNLOCK_ID, name: 'Unlock password-protected PDFs for text search', callback: this.openUnlock });

        app.workspace.onLayoutReady(() => {
            if (gen !== this.gen) return;
            const changed = (f: TAbstractFile) => { if (isIndexedFile(f)) void this.scan(); };
            this.refs = [
                app.vault.on('create', changed),
                app.vault.on('modify', changed),
                app.vault.on('delete', (f) => {
                    if (!this.index[f.path]) return;
                    this.put(f.path);
                    void this.save();
                }),
                app.vault.on('rename', (f, old) => {
                    if (!this.index[old]) return;
                    this.put(f.path, this.index[old]);
                    this.put(old);
                    void this.save();
                }),
            ];
            void this.scan();
        });
    }

    /** Stops indexing and removes the UI. The index file stays, so re-enabling is instant. */
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.gen++;
        this.refs.forEach((r) => this.plugin.app.vault.offref(r));
        this.refs = [];
        this.ribbon?.remove();
        this.ribbon = null;
        this.setCoreSearch(); // removes image results from open searches
        this.plugin.removeCommand(COMMAND_ID);
        this.plugin.removeCommand(REBUILD_ID);
        this.plugin.removeCommand(UNLOCK_ID);
        this.proc?.kill();
        this.proc = null;
    }

    /** Reads the shards whose file changed since they were last read. */
    private async load() {
        const { adapter } = this.plugin.app.vault;
        const gen = this.gen;
        await this.saving; // else a disable/enable mid-save reads the old files over newer entries
        const changed: { s: number; m: number; entries: OcrIndex }[] = [];
        // ponytail: 64 stats per call, one at a time (lower peak memory on phones). Add a manifest file if that is slow.
        for (let s = 0; s < SHARDS; s++) {
            try {
                const m = (await adapter.stat(this.shardPath(s)))?.mtime;
                // A dirty shard has entries a failed save didn't write; the next save writes them over the file.
                if (m === undefined || m === this.loadedAt[s] || this.dirty.has(s)) continue; // no file yet, or already read
                changed.push({ s, m, entries: JSON.parse(await adapter.read(this.shardPath(s))) });
            } catch { /* unreadable or mid-sync: keep what we have for this shard */ }
        }
        if (gen !== this.gen) return;
        const stale = new Set(changed.map((c) => c.s));
        if (stale.size) for (const p of Object.keys(this.index)) if (stale.has(shardOf(p))) delete this.index[p];
        for (const c of changed) { Object.assign(this.index, c.entries); this.loadedAt[c.s] = c.m; }
        // After the shards: a retry (an earlier migration's save failed) must not overwrite newer entries.
        if (ImageTextSearch.canIndex) await this.migrateLegacy(gen);
    }

    /** One-time: moves the single-file index of earlier builds into shards. */
    private async migrateLegacy(gen: number) {
        const { adapter } = this.plugin.app.vault;
        const legacy = `${this.plugin.manifest.dir}/ocr-index.json`;
        try {
            if (!(await adapter.exists(legacy))) return;
            const index: OcrIndex = JSON.parse(await adapter.read(legacy));
            if (gen !== this.gen) return;
            // Adds only paths the shards lack. A path a scan dropped can come back; the next scan drops it again.
            for (const [p, e] of Object.entries(index)) if (!(p in this.index)) this.put(p, e);
            await this.save();
            if (!this.dirty.size) await adapter.remove(legacy); // only once every shard is on disk
        } catch (e) { console.error('Enhanced Canvas OCR: migrating the old index failed', e); }
    }

    /** Device-local state: not in the synced index, since another device may read what this one can't (codecs, OCR). */
    private loadDevice() {
        const d = this.plugin.app.loadLocalStorage(DEVICE_KEY);
        this.failed = new Map(Object.entries(d?.failed ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number'));
        this.readImage = d?.readImage === true;
        this.pdfLockChecked = d?.pdfLockChecked === true;
    }

    private saveDevice() {
        this.plugin.app.saveLocalStorage(DEVICE_KEY, { failed: Object.fromEntries(this.failed), readImage: this.readImage, pdfLockChecked: this.pdfLockChecked });
    }

    /** On search-only devices, picks up an index file that sync replaced. */
    async refresh() {
        if (this.enabled && !ImageTextSearch.canIndex) await this.load();
    }

    /** Writes never overlap (that can truncate the file); calls made while one waits share it. */
    private save() {
        if (this.saveQueued) return this.saving;
        this.saveQueued = true;
        return this.saving = this.saving.then(async () => {
            this.saveQueued = false;
            const { adapter } = this.plugin.app.vault;
            const shards = [...this.dirty];
            this.dirty.clear();
            // Snapshot now (no await before this), so entries changed during the writes go to the next save.
            const out = new Map<number, OcrIndex>(shards.map((s) => [s, {}]));
            for (const [p, e] of Object.entries(this.index)) {
                const o = out.get(shardOf(p));
                if (o) o[p] = e;
            }
            try {
                if (!(await adapter.exists(this.indexDir))) await adapter.mkdir(this.indexDir);
                for (const s of shards) {
                    await adapter.write(this.shardPath(s), JSON.stringify(out.get(s)));
                    this.loadedAt[s] = (await adapter.stat(this.shardPath(s)))?.mtime ?? -1;
                }
            } catch (e) {
                shards.forEach((s) => this.dirty.add(s)); // rewriting a shard is harmless; losing one is not
                console.error('Enhanced Canvas OCR: saving the index failed', e);
            }
        });
    }

    /**
     * Forgets every reading, failures included, and reads all images again. Keeps unlocked PDFs: their password
     * isn't kept, so they couldn't be read again. One changed since is re-read by the scan, and so locked again.
     */
    private async rebuild() {
        // Abort a running scan: its todo list was built from the old index.
        this.gen++;
        this.proc?.kill();
        this.proc = null;
        this.index = Object.fromEntries(Object.entries(this.index).filter(([, e]) => e.pw === 'unlocked'));
        for (let s = 0; s < SHARDS; s++) this.dirty.add(s);
        this.failed.clear();
        this.saveDevice();
        this.broken = false;
        this.blockedBy = null;
        this.silentRuns = 0;
        await this.save();
        new Notice('Enhanced Canvas: rebuilding the image and PDF text index…');
        void this.scan();
    }

    /** OCR every image whose mtime changed since it was indexed; drop entries whose image is gone or excluded. */
    private async scan() {
        if (this.scanning) { this.rescan = true; return; }
        this.scanning = true;
        const { vault, metadataCache } = this.plugin.app;
        // Settings → Files and links → Excluded files.
        const excluded = (p: string) => metadataCache.isUserIgnored?.(p) ?? false;
        const stale = (f: TFile) => {
            const e = this.index[f.path];
            // An empty PDF from an earlier build may be a locked one (they were indexed alike): read once more.
            if (e?.m === f.stat.mtime) return !this.pdfLockChecked && isPdf(f) && !e.l.length && !e.pw;
            return this.failed.get(f.path) !== f.stat.mtime;
        };
        let locked = 0; // PDFs this scan found password-protected
        try {
            do {
                this.rescan = false;
                const gen = this.gen;
                const gone = Object.keys(this.index).filter((p) => !isIndexedFile(vault.getAbstractFileByPath(p)) || excluded(p));
                gone.forEach((p) => this.put(p));
                if (gone.length) await this.save();
                const lost = [...this.failed.keys()].filter((p) => !isIndexedFile(vault.getAbstractFileByPath(p)) || excluded(p));
                lost.forEach((p) => this.failed.delete(p));
                if (lost.length) this.saveDevice();

                const todo = vault.getFiles().filter((f) => isIndexedFile(f) && !excluded(f.path) && stale(f)
                    && !(this.broken && !isPdf(f)));
                const notice = todo.length > BATCH || todo.filter(isPdf).length > PDF_BATCH ? new Notice('', 0) : null;
                let warned = false;
                try {
                    for (let i = 0, n = 0; i < todo.length && gen === this.gen; i += n) {
                        notice?.setMessage(`Enhanced Canvas: reading text in images and PDFs ${i} / ${todo.length}`);
                        let pdfs = 0;
                        for (n = 0; i + n < todo.length && n < BATCH && pdfs < PDF_BATCH; n++) if (isPdf(todo[i + n])) pdfs++;
                        const batch = todo.slice(i, i + n);
                        // Taken before OCR: an image changed mid-run must still look stale afterwards.
                        const mtimes = batch.map((f) => f.stat.mtime);
                        const lines = await this.ocr(batch, gen);
                        if (gen !== this.gen) break; // disabled: the OCR process was killed, not a failure

                        let bad = 0, badCodec = 0;
                        batch.forEach((f, j) => {
                            const l = lines[j];
                            if (l === undefined) return; // an image skipped while OCR is broken
                            if (l === 'locked') {
                                // Unlocked in PdfUnlockModal while this batch was reading it: keep that text.
                                const e = this.index[f.path];
                                if (e?.pw === 'unlocked' && e.m === mtimes[j]) return;
                                if (vault.getAbstractFileByPath(f.path) !== f) return;
                                this.put(f.path, { m: mtimes[j], l: [], pw: 'locked' });
                                locked++;
                            } else if (!l) {
                                this.failed.set(f.path, mtimes[j]); bad++;
                                if (NEEDS_CODEC.test(f.extension)) badCodec++;
                                console.warn('Enhanced Canvas OCR: could not read', f.path);
                            }
                            // Skip a file deleted while it was being read.
                            else if (vault.getAbstractFileByPath(f.path) === f) this.put(f.path, { m: mtimes[j], l });
                        });
                        await this.save();
                        this.saveDevice();
                        if (bad && !warned) {
                            warned = true;
                            const codec = Platform.isWin && badCodec
                                ? ` ${badCodec} of them are HEIC or WebP, which Windows reads only with "HEIF Image Extensions" / "WebP Image Extensions" from the Microsoft Store.`
                                : '';
                            new Notice(`Enhanced Canvas: couldn't read text in ${bad} file${bad === 1 ? '' : 's'}.${codec} They're retried when changed, or run "Rebuild image and PDF text index".`);
                        }
                    }
                } finally {
                    notice?.hide();
                }
                if (gen === this.gen && !this.pdfLockChecked) { this.pdfLockChecked = true; this.saveDevice(); }
            } while (this.rescan && this.enabled);
        } finally {
            this.scanning = false;
        }
        // One notice per scan, never a password prompt: indexing runs in the background, often at startup.
        if (locked && this.enabled) {
            const n = this.lockedPdfs().length;
            if (!n) return;
            const notice = new Notice(createFragment((el) => {
                el.appendText(`Enhanced Canvas: ${n} PDF${n === 1 ? ' is' : 's are'} password-protected, so ${n === 1 ? 'its' : 'their'} text isn't searchable yet. `);
                el.createEl('a', { text: 'Unlock…', href: '#' }).addEventListener('click', (e) => { e.preventDefault(); notice.hide(); this.openUnlock(); });
            }), 0);
        }
    }

    private openUnlock = () => { if (this.enabled) new PdfUnlockModal(this).open(); };

    /** PDFs waiting for a password; one changed since it was found locked waits for the next scan instead. */
    lockedPdfs(): TFile[] {
        const { vault } = this.plugin.app;
        return Object.entries(this.index).flatMap(([p, e]) => {
            const f = vault.getAbstractFileByPath(p);
            return e.pw === 'locked' && f instanceof TFile && e.m === f.stat.mtime ? [f] : [];
        }).sort((a, b) => a.path.localeCompare(b.path)); // index order is by hash shard
    }

    /** Reads a locked PDF with `password` into the index. The password is used for this read only and never stored. */
    async unlockPdf(f: TFile, password: string): Promise<'ok' | 'wrong' | 'failed'> {
        const m = f.stat.mtime; // before reading, like scan(): a change mid-read must still look stale
        const l = await this.readPdf(f, this.gen, password);
        if (l === 'locked') return 'wrong';
        if (!l || !this.enabled || this.plugin.app.vault.getAbstractFileByPath(f.path) !== f) return 'failed';
        this.put(f.path, { m, l, pw: 'unlocked' });
        await this.save();
        return 'ok';
    }

    /**
     * Images through osascript (macOS) or PowerShell (Windows), PDFs through pdf.js; in the order given. null = could not read that file;
     * undefined = an image skipped because OCR is broken, or anything after `gen` changed. 'locked' = a PDF that needs a password.
     */
    private async ocr(files: TFile[], gen: number): Promise<(OcrLine[] | null | undefined | 'locked')[]> {
        const images = this.broken ? [] : files.filter((f) => !isPdf(f));
        let read = images.length ? await this.ocrImages(images) : [];
        // One bad image fails the whole run: retry one by one so it can't block the rest.
        if (!read && images.length > 1 && !this.broken) {
            read = [];
            let crashed = 0; // runs that failed as a whole, not one image the run reported as unreadable
            let silent = 0; // of those, Windows runs that ended with no error text (see silentRuns)
            for (const f of images) {
                if (gen !== this.gen) return [];
                if (this.broken) break;
                const one = await this.ocrImages([f]);
                if (!one) { crashed++; if (this.silentRuns) silent++; }
                read.push(one?.[0] ?? null);
                // ponytail: the first 3 runs (or all of a smaller batch) failing = OCR is broken, not the images; saves up to ~18 min of retries.
                // Later failures in a row are not checked: each is retried and marked failed on its own.
                if (crashed === read.length && (read.length === 3 || read.length === images.length)) {
                    this.broken = true;
                    // Every run died without a word: EDR terminating the process leaves no AMSI text to match.
                    if (silent === crashed && !this.blockedBy) this.blockedBy = 'stopped';
                    break;
                }
            }
        }
        if (gen !== this.gen) return [];
        // One image per run never reaches the retries above (a pasted screenshot): 3 silent runs in a row, across scans, also pause.
        if (!this.broken && this.silentRuns >= 3) {
            this.broken = true;
            if (!this.blockedBy) this.blockedBy = 'stopped';
        }
        if (read?.some(Boolean)) this.readImage = true;
        // Every image failing means OCR itself is broken: pause images instead of marking them all failed. PDFs go on.
        // Only formats that always decode count: a batch of HEIC without the codec fails with OCR working fine.
        // Not once an image was ever read on this device (readImage, not the index: it may be synced from another device):
        // then OCR works and these files are bad (corrupt, or not really images).
        // ocrImages() also sets broken for a known block (no OCR language, policy, antivirus), even for a single image.
        const decodable = images.flatMap((f, j) => (ALWAYS_DECODABLE.test(f.extension) ? [j] : []));
        if (decodable.length > 1 && decodable.every((j) => !read?.[j]) && !this.readImage) {
            console.warn('Enhanced Canvas OCR: no image could be read, pausing image OCR:', decodable.map((j) => images[j].path));
            this.broken = true;
        }
        if (images.length && this.broken) {
            const why = this.blockedBy ? BLOCK_HINT[this.blockedBy]
                : 'See the developer console (Ctrl+Shift+I) for the error.';
            new Notice(`Enhanced Canvas: text recognition in images isn't working, so reading images is paused. ${why} Then run "Rebuild image and PDF text index".`, 0);
        }
        const out: (OcrLine[] | null | undefined | 'locked')[] = [];
        let k = 0;
        for (const f of files) {
            if (gen !== this.gen) break;
            out.push(isPdf(f) ? await this.readPdf(f, gen) : this.broken ? undefined : read?.[k++] ?? null);
        }
        return out;
    }

    /**
     * A PDF's embedded text with Obsidian's own pdf.js: no OCR, so a scanned PDF indexes as empty.
     * Measured on 302 PDFs against macOS PDFKit (docs/design-ocr-index-per-device.md): same text, a bit faster.
     * 'locked' = needs a password (none given, or a wrong one). Only a user password locks: an owner password
     * (no printing, copying…) opens without one.
     */
    private async readPdf(f: TFile, gen: number, password?: string): Promise<OcrLine[] | null | 'locked'> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let doc: any;
        try {
            const pdfjs = await loadPdfJs();
            // Without the CMaps, CJK text in CID fonts (e.g. LaTeX output) comes out mostly empty. Same URL as Obsidian's PDF view.
            doc = await pdfjs.getDocument({ data: await this.plugin.app.vault.readBinary(f), password, cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true }).promise;
            const lines: OcrLine[] = [];
            for (let i = 1; i <= doc.numPages; i++) {
                if (gen !== this.gen) return null; // disabled or rebuilding: the caller drops this batch
                const page = await doc.getPage(i);
                let cur = '';
                const flush = () => {
                    // Math fonts without a Unicode map give control characters for − · ×: unsearchable noise.
                    // A tab separates words, so it becomes a space instead.
                    // eslint-disable-next-line no-control-regex
                    for (const t of cur.split(/\r\n|\r|\n/)) { const s = t.replace(/\t/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim(); if (s) lines.push([s, i]); }
                    cur = '';
                };
                for (const it of (await page.getTextContent()).items) { cur += it.str ?? ''; if (it.hasEOL) flush(); }
                flush();
                page.cleanup();
            }
            return lines;
        } catch (e) {
            if (e?.name === 'PasswordException') return 'locked'; // retrying without a password won't change that
            console.error('Enhanced Canvas OCR: reading the PDF failed', f.path, e);
            return null;
        } finally {
            void doc?.destroy();
        }
    }

    private ocrImages(files: TFile[]): Promise<(OcrLine[] | null)[] | null> {
        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return Promise.resolve(null);
        // Required lazily: child_process doesn't exist on mobile, where this never runs.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spawn } = require('child_process') as typeof import('child_process');
        const gen = this.gen;
        const paths = files.map((f) => Platform.isWin ? longPath(adapter.getFullPath(f.path)) : adapter.getFullPath(f.path));
        // A hung process must not stall indexing forever.
        const timeout = 20_000 + 2_000 * files.length;
        // Full path: a damaged PATH must not hide the PowerShell that every Windows 10/11 ships.
        const powershell = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
        const block = (why: OcrBlock) => { this.broken = true; this.blockedBy = why; };
        return new Promise((resolve) => {
            const proc = this.proc = Platform.isWin
                ? spawn(powershell, ['-NoProfile', '-NonInteractive',
                    '-EncodedCommand', Buffer.from(WIN_OCR_SCRIPT, 'utf16le').toString('base64')], { timeout, windowsHide: true })
                : spawn('osascript', ['-l', 'JavaScript', '-e', OCR_SCRIPT, ...paths], { timeout });
            // ASCII-only JSON (\uXXXX escapes), so the console code page can't garble a path.
            if (Platform.isWin) proc.stdin?.end(JSON.stringify(paths).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
            let out = '', err = '';
            // Decode as one stream: a CJK character split across two chunks would otherwise be garbled.
            proc.stdout?.setEncoding('utf8');
            proc.stderr?.setEncoding('utf8');
            proc.stdout?.on('data', (d) => (out += d));
            proc.stderr?.on('data', (d) => (err += d));
            // 'close' may still follow 'error': handle only the first.
            let done = false;
            proc.on('error', (e: NodeJS.ErrnoException) => {
                if (done) return;
                done = true;
                this.silentRuns = 0;
                if (this.proc === proc) this.proc = null;
                // Couldn't start at all: missing, or refused by antivirus / Defender ASR (EPERM, EACCES, UNKNOWN).
                if (Platform.isWin && gen === this.gen) block(e.code === 'ENOENT' ? 'missing' : 'blocked');
                console.error('Enhanced Canvas OCR:', e);
                resolve(null);
            });
            proc.on('close', (code, signal) => {
                if (done) return;
                done = true;
                if (this.proc === proc) this.proc = null;
                // A signal means our own kill (timeout or disable()); exit 2/3 or any stderr has a known cause.
                const silent = Platform.isWin && code !== 0 && code !== 2 && code !== 3 && signal === null && !err.trim();
                this.silentRuns = silent ? this.silentRuns + 1 : 0;
                try {
                    // No check for being killed from outside: on Windows that is just a nonzero code with no signal,
                    // and a signal only ever comes from our own kill (timeout, or disable() which changes gen).
                    if (Platform.isWin && gen === this.gen) {
                        if (code === 2) block('no-language'); // every image would fail
                        else if (code === 3) block('constrained');
                        else if (AV_BLOCKED.test(err)) block('blocked');
                    }
                    if (code !== 0) throw new Error(err || `OCR process exited with ${code ?? signal}`);
                    const read: (OcrLine[] | null)[] = JSON.parse(out);
                    if (!Array.isArray(read) || read.length !== files.length) throw new Error(`OCR returned ${Array.isArray(read) ? read.length : 'no'} results for ${files.length} images`);
                    if (Platform.isWin) for (const l of read) l?.forEach((x) => (x[0] = x[0].replace(CJK_GAP, '')));
                    resolve(read);
                } catch (e) {
                    if (gen === this.gen) console.error('Enhanced Canvas OCR:', e); // else killed by disable()
                    resolve(null);
                }
            });
        });
    }

    /** Normalized text of each line, cached per index entry (a re-read image gets a new array). */
    private normCache = new WeakMap<OcrLine[], string[]>();
    private norm(l: OcrLine[]) {
        let n = this.normCache.get(l);
        if (!n) this.normCache.set(l, n = l.map((x) => normalizeText(x[0])));
        return n;
    }

    /** OCR lines of one image with their normalized text; null when off or not indexed. */
    textOf(path: string) {
        const l = this.index[path]?.l;
        return this.enabled && l ? { lines: l, norm: this.norm(l) } : null;
    }

    /**
     * Every match of `input` (parseTextQuery syntax) among files of `kind`, most matching lines
     * first and numbered; `counts` holds every kind's match count. The modal pages through them.
     */
    search(input: string, kind: FileKind = 'all') {
        const query = parseTextQuery(input), terms = queryTerms(query);
        const { vault } = this.plugin.app;
        const results: { path: string; hits: OcrLine[]; terms: string[]; n: number }[] = [];
        const counts: Record<FileKind, number> = { all: 0, image: 0, pdf: 0 };
        if (!terms.length) return { results, counts };
        // ponytail: linear scan of the whole index for the total; fine for a few thousand images.
        for (const [path, { l }] of Object.entries(this.index)) {
            const norm = this.norm(l);
            // Per line, so a phrase can't span OCR lines: every match then has a line to box.
            if (!matchesTextQuery(query, (t) => norm.some((n) => n.includes(t)))) continue;
            const file = vault.getAbstractFileByPath(path);
            if (!isIndexedFile(file)) continue; // deleted, entry not pruned yet
            const fileKind = isImageFile(file) ? 'image' : 'pdf';
            counts.all++;
            counts[fileKind]++;
            if (kind !== 'all' && kind !== fileKind) continue;
            results.push({ path, terms, n: 0, hits: l.filter((_, i) => terms.some((t) => norm[i].includes(t))) });
        }
        results.sort((a, b) => b.hits.length - a.hits.length);
        results.forEach((r, i) => (r.n = i + 1));
        return { results, counts };
    }

    /** Indexed image path → notes that embed or link it. Walks every link once: build per modal, not per result. */
    backlinks() {
        const map = new Map<string, string[]>();
        for (const [source, links] of Object.entries(this.plugin.app.metadataCache.resolvedLinks)) {
            for (const dest in links) {
                if (!this.index[dest]) continue;
                const sources = map.get(dest);
                if (sources) sources.push(source); else map.set(dest, [source]);
            }
        }
        return map;
    }

    /** Line in `source` of its first embed of or link to the image. */
    refLine(source: string, imagePath: string) {
        const { metadataCache } = this.plugin.app;
        const cache = metadataCache.getCache(source);
        return [...(cache?.embeds ?? []), ...(cache?.links ?? [])]
            .find((r) => metadataCache.getFirstLinkpathDest(r.link.split('#')[0], source)?.path === imagePath)
            ?.position.start.line ?? 0;
    }
}

/** Draws a highlight box over each OCR line on an element laid over the image. */
export function drawOcrBoxes(container: HTMLElement, lines: OcrLine[]) {
    for (const l of lines) {
        if (l.length !== 5) continue; // PDF text has no box
        const [, x, y, w, h] = l;
        const box = container.createDiv('ec-ocr-box');
        box.setCssStyles({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    }
}

type ImageTextResult = ReturnType<ImageTextSearch['search']>['results'][number];
type FileKind = 'all' | 'image' | 'pdf';
const KIND_LABELS: Record<FileKind, string> = { all: 'All', image: 'Images', pdf: 'PDFs' };

/** Last row when results are cut: choosing it shows the next PAGE in place. */
type ShowMore = { more: number };
type ModalRow = ImageTextResult | ShowMore;
const isShowMore = (r: ModalRow): r is ShowMore => 'more' in r;

class ImageTextModal extends SuggestModal<ModalRow> {
    private backlinks: Map<string, string[]>;
    private countEl: HTMLElement;
    private filterEl: HTMLElement; // hidden until there's a query: no results, nothing to filter
    private kind: FileKind = 'all'; // every open starts at All, so a forgotten filter never hides results
    private kindButtons = new Map<FileKind, { button: HTMLButtonElement; count: HTMLElement }>();
    // Paging: the full result list is kept per query + kind, so "Show more" doesn't rescan the index.
    private cache?: { key: string } & ReturnType<ImageTextSearch['search']>;
    private shown = PAGE;

    constructor(private search: ImageTextSearch) {
        super(search.plugin.app);
        this.backlinks = search.backlinks();
        this.setPlaceholder('Search text inside images and PDFs: words, OR, "exact phrase"');
        // modal's own document (pop-out windows)
        const filterEl = this.filterEl = this.modalEl.createDiv('ec-ocr-filter');
        const segmentEl = filterEl.createDiv('ec-ocr-segment');
        for (const kind of Object.keys(KIND_LABELS) as FileKind[]) {
            const button = segmentEl.createEl('button', { cls: 'ec-ocr-filter-button', text: KIND_LABELS[kind] });
            const count = button.createSpan('ec-ocr-filter-count');
            button.toggleClass('is-active', kind === this.kind);
            // Keep focus in the input: mousedown would otherwise take it before click.
            button.addEventListener('mousedown', (e) => e.preventDefault());
            button.addEventListener('click', () => this.setKind(kind));
            this.kindButtons.set(kind, { button, count });
        }
        // Compact view: CSS hides thumbnails (lazy images then never load) and keeps one match line.
        // Not remembered: a view toggle, one click away.
        const compactButton = filterEl.createDiv('clickable-icon ec-ocr-compact-toggle');
        const setCompact = (on: boolean) => {
            this.modalEl.toggleClass('ec-ocr-compact', on);
            setIcon(compactButton, on ? 'copy-plus' : 'copy-minus');
            compactButton.setAttribute('aria-label', on ? 'Show thumbnails' : 'Hide thumbnails');
        };
        setCompact(false);
        compactButton.addEventListener('mousedown', (e) => e.preventDefault());
        compactButton.addEventListener('click', () => setCompact(!this.modalEl.hasClass('ec-ocr-compact')));
        this.countEl = this.modalEl.createDiv('ec-ocr-count');
        filterEl.hide();
        this.resultContainerEl.before(filterEl, this.countEl);
    }

    private setKind(kind: FileKind) {
        this.kind = kind;
        for (const [k, { button }] of this.kindButtons) button.toggleClass('is-active', k === kind);
        // SuggestModal has no public refresh: an input event re-runs getSuggestions.
        this.inputEl.dispatchEvent(new Event('input'));
        this.inputEl.focus();
    }

    getSuggestions(query: string): ModalRow[] {
        const key = `${this.kind}\n${query}`;
        if (this.cache?.key !== key) this.shown = PAGE; // a new query or filter starts from the top again
        // Reuse the list only once the index is complete; while it's still being read, rescan so
        // "Show more" and switching back to a tab pick up the files read since.
        if (this.cache?.key !== key || this.search.isIndexing) this.cache = { key, ...this.search.search(query, this.kind) };
        const { results, counts } = this.cache, total = results.length;
        const page: ModalRow[] = results.slice(0, this.shown);
        if (total > this.shown) page.push({ more: total - this.shown });
        this.limit = page.length; // SuggestModal cuts at `limit`
        const hasQuery = !!query.trim();
        this.filterEl.toggle(hasQuery);
        for (const [k, { count }] of this.kindButtons) count.setText(hasQuery ? String(counts[k]) : '');
        const count = !hasQuery ? ''
            : total > this.shown ? `Showing ${this.shown} of ${total} results; add words or pick a type to narrow them`
            : `${total} result${total === 1 ? '' : 's'}`;
        // Before the index is complete, "no results" may just mean "not read yet".
        const indexing = this.search.isIndexing ? 'Still reading images and PDFs; results may be incomplete.' : '';
        this.countEl.setText([count, indexing].filter(Boolean).join(' · '));
        return page;
    }

    /** "Show more" adds a page without closing; anything else opens as usual. */
    selectSuggestion(row: ModalRow, evt: MouseEvent | KeyboardEvent) {
        if (!isShowMore(row)) return super.selectSuggestion(row, evt);
        const first = this.shown, top = this.resultContainerEl.scrollTop;
        this.shown += PAGE;
        // Redraws the whole list (SuggestModal has no append), then puts the view back where it was
        // and selects the first new result. Browser scroll anchoring keeps it there as thumbnails load.
        this.inputEl.dispatchEvent(new Event('input'));
        this.resultContainerEl.scrollTop = top;
        // ponytail: chooser is private Obsidian API; without it selection resets to the first row.
        (this as any).chooser?.setSelectedItem?.(first, false);
        this.resultContainerEl.children[first]?.scrollIntoView({ block: 'nearest' });
    }

    renderSuggestion(item: ModalRow, el: HTMLElement) {
        if (isShowMore(item)) {
            el.addClass('ec-ocr-more');
            el.setText(`Show ${Math.min(PAGE, item.more)} more (${item.more} remaining)`);
            return;
        }
        const { path, hits, terms, n } = item;
        // search() keeps only existing files, but a cached page can outlive a delete or rename.
        const file = this.app.vault.getAbstractFileByPath(path);
        const row = el.createDiv('ec-ocr-result');
        const thumb = row.createDiv('ec-ocr-thumb');
        const isImage = isImageFile(file);
        if (isImage) {
            thumb.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), loading: 'lazy' } });
            drawOcrBoxes(thumb, hits);
        } else setIcon(thumb, 'file-text');

        const meta = row.createDiv('ec-ocr-meta');
        const name = meta.createDiv('ec-ocr-name');
        setIcon(name.createSpan('ec-ocr-kind-icon'), isImage ? 'image' : 'file-text'); // compact view only
        name.appendText(`${n}. ${file?.name ?? path.split('/').pop()}`);
        for (const l of hits.slice(0, 3)) {
            const line = meta.createDiv('ec-ocr-line');
            if (l.length === 2) line.createSpan({ cls: 'ec-ocr-page', text: `p. ${l[1]} ` });
            markWords(line, l[0], terms);
        }
        const notes = this.backlinks.get(path);
        if (notes) meta.createDiv({ cls: 'ec-ocr-notes', text: '↳ ' + notes.map((n) => n.split('/').pop()?.replace(/\.md$/, '')).join(', ') });
    }

    /**
     * A PDF opens at the page of its first match. An image opens the note that embeds it, at
     * the embed's line (a canvas zooms to the image card); else the image itself.
     */
    async onChooseSuggestion(row: ModalRow) {
        if (isShowMore(row)) return; // handled in selectSuggestion
        const { path, hits } = row;
        const first = hits[0];
        if (first?.length === 2) {
            // Not openLinkText: it splits the path at the first '#', which a file name may contain.
            const pdf = this.app.vault.getAbstractFileByPath(path);
            if (pdf instanceof TFile) await this.app.workspace.getLeaf(false).openFile(pdf, { eState: { subpath: `#page=${first[1]}` } });
            return;
        }
        const note = this.backlinks.get(path)?.[0];
        const file = this.app.vault.getAbstractFileByPath(note ?? path);
        if (!(file instanceof TFile)) return;
        const leaf = this.app.workspace.getLeaf(false);
        const isCanvas = file.extension === 'canvas';
        await leaf.openFile(file, note && !isCanvas ? { eState: { line: this.search.refLine(note, path) } } : {});
        if (!isCanvas) return;
        const canvas = (leaf.view as CanvasView).canvas;
        // ponytail: first card showing the image; an image embedded inside a text card isn't found.
        const node = canvas && [...canvas.nodes.values()].find((n) => n.filePath === path);
        if (node) canvas.zoomToBbox(node.getBBox());
    }
}

/**
 * One row per locked PDF, each with its own password. A password that opens one is also tried on the rest:
 * PDFs often share one (bank statements), but that isn't assumed.
 */
class PdfUnlockModal extends Modal {
    private busy = false;

    constructor(private search: ImageTextSearch) {
        super(search.plugin.app);
    }

    onOpen() {
        this.setTitle('Unlock password-protected PDFs');
        const { contentEl } = this;
        const files = this.search.lockedPdfs();
        if (!files.length) {
            contentEl.createEl('p', { text: 'No password-protected PDFs are waiting to be unlocked.' });
            return;
        }
        contentEl.createEl('p', { text: 'Enter a PDF\'s password once to make its text searchable. A password that opens one PDF is tried on the others too. The password isn\'t saved; the text stays in the index, also through "Rebuild image and PDF text index", until the PDF changes.' });
        contentEl.createEl('p', { cls: 'mod-warning', text: 'The text of an unlocked PDF is stored unencrypted in the index (plugin folder, ocr-index), which syncs with your vault.' });

        const folder = (f: TFile) => (f.parent && !f.parent.isRoot() ? f.parent.path : '');
        const pending = new Map<TFile, Setting>();
        const done = (f: TFile, row: Setting) => {
            pending.delete(f);
            row.controlEl.empty();
            row.setDesc(folder(f)); // clears an earlier "Wrong password."
            row.descEl.removeClass('mod-warning');
            row.controlEl.createSpan({ text: '✓ Unlocked' });
        };
        for (const f of files) {
            const row = new Setting(contentEl).setName(f.name).setDesc(folder(f));
            pending.set(f, row);
            let input!: HTMLInputElement;
            let button!: ButtonComponent;
            const submit = async () => {
                const pw = input.value;
                if (!pw || this.busy) return;
                this.busy = true;
                for (const r of pending.values()) r.setDisabled(true); // reading a large PDF takes a moment
                button.setButtonText('Unlocking…');
                let unlocked = false, failed = false;
                try {
                    const r = await this.search.unlockPdf(f, pw);
                    if (r !== 'ok') {
                        row.setDesc(r === 'wrong' ? 'Wrong password.' : 'Couldn\'t read this PDF. See the developer console (Ctrl+Shift+I).');
                        row.descEl.addClass('mod-warning');
                        failed = true;
                        return;
                    }
                    unlocked = true;
                    done(f, row);
                    for (const [other, otherRow] of [...pending]) {
                        if (await this.search.unlockPdf(other, pw) === 'ok') done(other, otherRow);
                    }
                    if (!pending.size) new Notice('Enhanced Canvas: every password-protected PDF is unlocked and searchable.');
                } finally {
                    this.busy = false;
                    for (const r of pending.values()) r.setDisabled(false);
                    if (pending.has(f)) button.setButtonText('Unlock');
                    if (failed) input.select(); // after re-enabling: a disabled input can't take focus
                    if (unlocked && this.search.inCoreSearch) this.search.setCoreSearch(); // open Search shows the new text
                }
            };
            row.addText((t) => {
                input = t.inputEl;
                input.type = 'password';
                t.setPlaceholder('Password');
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });
            });
            row.addButton((b) => { button = b; b.setButtonText('Unlock').setCta().onClick(() => void submit()); });
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

function markWords(el: HTMLElement, text: string, words: string[]) {
    const n = normalizeText(text);
    // ponytail: assumes NFKC keeps string length; a rare ligature shifts the mark by a char.
    for (let i = 0; i < text.length;) {
        const w = words.find((w) => n.startsWith(w, i));
        if (w) { el.createEl('mark', { text: text.slice(i, i + w.length) }); i += w.length; }
        else { el.appendText(text[i]); i++; }
    }
}
