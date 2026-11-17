import { ButtonComponent, EventRef, FileSystemAdapter, Modal, Notice, Platform, Setting, SuggestModal, TAbstractFile, TFile, loadPdfJs, setIcon } from 'obsidian';
import type { ChildProcess } from 'child_process';
import { around } from 'monkey-around';

import EnhancedCanvas from '../main';
import type { CanvasView } from '../Canvas';
import { matchesTextQuery, normalizeText, parseTextQuery, queryTerms, randomId } from './utils';
import { BuiltinOcr } from './BuiltinOcr';
import { ASSETS_BYTES, DownloadResult } from './OcrAssets';

const IMAGE_EXT = /^(png|jpe?g|heic|webp|gif|tiff?|bmp)$/i;
const BATCH = 50; // files per OCR process run; keeps argv short and saves progress often
const PDF_BATCH = 5; // at most this many PDFs per batch: a large one takes seconds, and progress is saved per batch
// localStorage (per vault, per device): `failed`, `reread`, `readBy`, `pdfLockChecked`, `broken`, `blockedBy`
const DEVICE_KEY = 'enhanced-canvas-ocr-device';
// localStorage (per vault, per device), Windows only: 'builtin' or 'system'. Empty = the default, 'builtin': PowerShell
// starts only once the user picks Windows OCR (settings, or "Keep using Windows OCR").
const ENGINE_KEY = 'enhanced-canvas-ocr-engine';
export type OcrEngine = 'system' | 'builtin';
// Crash guard for the system OCR (docs/design-ocr-consent-and-crash-guard.md, part B). Endpoint security (EDR) may kill the
// whole Obsidian process when PowerShell/osascript starts, so nothing after the spawn ever runs. A marker file, one per
// vault, is written synchronously before each spawn and removed MARKER_LINGER after the process ends (or on quit):
// finding it at startup means the last run never came back. The verdict then goes to a file every vault on this
// computer checks before spawning, so a computer is killed at most once, not once per vault.
const MARKER_LINGER = 10_000; // ponytail: a guess; EDR may kill Obsidian just after PowerShell ends. Tune once seen on an XDR machine.
/** Device-wide verdict (KILL_FILE): `kills` = times Obsidian was found killed mid-run; `continued` = the user chose to keep using the system OCR since. */
type KillVerdict = { kills: number; continued: boolean };
const PAGE = 50; // results the modal shows at first, and adds per "Show more"
const COMMAND_ID = 'search-image-text';
const CLEAN_SHARED_ID = 'remove-other-devices-image-text';
const REBUILD_ID = 'rebuild-image-text-index';
const UNLOCK_ID = 'unlock-pdfs-for-text-search';
const REMOVE_BUILTIN_ID = 'remove-builtin-ocr-files';
const MB = (bytes: number) => Math.round(bytes / 1e6);
const DOWNLOAD_FAILED: Record<Exclude<DownloadResult, 'ok'>, string> = {
    network: 'Couldn\'t download built-in OCR. Check your connection, or your network may block github.com.',
    hash: 'The downloaded built-in OCR file didn\'t match. It may have been altered or cut off.',
    storage: 'Couldn\'t save the built-in OCR files (storage may be full).',
};
// Shared image text (docs/design-ocr-index-per-device.md §5.4): files in the config folder's top level, the only place
// there Obsidian Sync carries to phones (subfolders and plugin data aren't). Each desktop writes only its own files:
// a base `enhanced-canvas-ocr.<id>.json` (split into `.<id>.1.json`… past PART_BYTES) and a delta `.<id>.new.json`.
const SHARED_FILE = /^enhanced-canvas-ocr\.([0-9a-f]+)(?:\.(new|\d+))?\.json$/;
const SHARED_ID_KEY = 'enhanced-canvas-ocr-id'; // localStorage (per vault, per device): this device's id in the file names
const SHARED_DELAY = 30_000; // a write waits for this much quiet, so a burst of changes uploads once
const DELTA_BYTES = 200_000; // a larger delta is merged into the base
const PART_BYTES = 4_000_000; // per file, under Obsidian Sync Standard's 5 MB
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length; // not s.length: CJK is 3 bytes in UTF-8
/** One entry as the shared files store it: images only, so never `pw`. Also the text compared to skip a write. */
const entryJson = (e: OcrEntry) => JSON.stringify({ m: e.m, l: e.l });
/** An image entry read from another device's file; `w` is that file's `writtenAt`. */
type SharedEntry = { e: OcrEntry; w: number };
/** Another device's shared files: `files` = path → mtime when read, to skip unchanged files. */
type SharedDevice = { name: string; writtenAt: number; files: Record<string, number>; entries: Map<string, SharedEntry> };
/** This device's shared files as last read or written: `base` = path → entryJson in the base, `delta` = the delta's body. */
type OwnShared = { id: string; base: Map<string, string>; delta: string | null; files: Map<string, number> };
/** Shared files by device id. */
type SharedList = Map<string, { path: string; part: string | undefined }[]>;
/** A delta's comparable part (no `writtenAt`): `items` are `"path":entryJson`, in path order. */
const deltaBody = (items: string[], removed: string[]) => `"entries":{${items.join(',')}},"removed":${JSON.stringify([...removed].sort())}`;
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
/** By the path alone: an index entry's file may be gone. */
const isImagePath = (p: string) => { const dot = p.lastIndexOf('.'); return dot > p.lastIndexOf('/') && IMAGE_EXT.test(p.slice(dot + 1)); };
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
// PowerShell 7 can't load WinRT types). The script itself goes in on stdin (`-Command -`), not as
// -EncodedCommand: an encoded command line is what antivirus/EDR flags first. So the paths can't use stdin:
// winOcrScript() puts them in the script as JSON. Writes the same JSON shape as
// OCR_SCRIPT. Exit 2 = no OCR language installed; exit 3 = Constrained Language Mode (AppLocker/WDAC), where
// the .NET calls below are blocked — checked first, before anything that mode forbids. Both set `broken`.
// Engine: the user's first Chinese/Japanese/Korean language (Settings order) that has OCR, else the first installed
// CJK OCR language (system order, not the user's), else the first user-profile one. One engine
// reads one language; a CJK engine still reads Latin text, an English one drops every CJK character silently.
// JSON is written by hand: ConvertTo-Json in 5.1 can wrap arrays in {"value":…,"Count":…}.
// PowerShell variable names are case-insensitive: $w would overwrite $W, so the word loop uses $wd.
// Stdin is run statement by statement, like typed input: one try block makes the whole script a single statement
// (so an error can't fall through to the next line), and the blank line at the end is what completes it.
const WIN_OCR_SCRIPT = `try {
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 3 }
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
$paths = ConvertFrom-Json '__PATHS__' # assigned first: 5.1 emits the array as one object, so @(...) would nest it
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
[Console]::Out.Write('[' + ($out -join ',') + ']')
} catch { [Console]::Error.Write([string]$_); exit 1 }

`;
/** WIN_OCR_SCRIPT for these paths. ASCII-only JSON (\uXXXX escapes), so the console code page can't garble a path. */
function winOcrScript(paths: string[]) {
    const json = JSON.stringify(paths).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    // A function, so `$` in a path isn't a replacement pattern; '' is a literal ' in a single-quoted PowerShell string.
    return WIN_OCR_SCRIPT.replace('__PATHS__', () => json.replace(/'/g, "''"));
}
// Formats every OCR backend can decode. Windows needs Store codecs for HEIC (HEIF Image Extensions, not
// preinstalled) and WebP (may be removed on LTSC/debloated systems): only these formats can tell "OCR is broken".
const ALWAYS_DECODABLE = /^(png|jpe?g|gif|tiff?|bmp)$/i;
const NEEDS_CODEC = /^(heic|webp)$/i;

/** Why image OCR can't run at all, as opposed to one image failing. Each pauses image reading until Rebuild. */
type OcrBlock = 'no-language' | 'constrained' | 'blocked' | 'stopped' | 'missing' | 'killed';
const isOcrBlock = (v: unknown): v is OcrBlock => typeof v === 'string' && v in BLOCK_HINT;
const BLOCK_HINT: Record<OcrBlock, string> = {
    'no-language': 'Windows has no OCR language installed. Add one in Settings → Time & language → Language & region: pick a language → Language options → Optical character recognition.',
    'constrained': 'PowerShell runs in Constrained Language Mode, set by your organization\'s security policy (AppLocker or WDAC), which blocks Windows OCR. Only your IT administrator can allow it. PDFs are still indexed.',
    'blocked': 'PowerShell was blocked or stopped, most likely by antivirus or a company security policy. Allow powershell.exe for Obsidian, or ask your IT administrator. PDFs are still indexed.',
    'stopped': 'PowerShell kept closing without an error message, which usually means antivirus or endpoint security (EDR) stopped it. Allow powershell.exe for Obsidian, or ask your IT administrator. PDFs are still indexed.',
    'missing': 'Windows PowerShell (powershell.exe) wasn\'t found on this system. PDFs are still indexed.',
    // Shown by noticeKilled(), which has its own wording and buttons; this is for completeness.
    'killed': 'Obsidian was closed while the system\'s OCR was running, possibly by company security software. PDFs are still indexed.',
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

// Files outside the vault (README: "Files outside the vault"). Sync fs on purpose: a write that's still queued when
// EDR kills the process is lost, and so is localStorage, which Chromium flushes to disk later.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs = () => require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodePath = () => require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeOs = () => require('os') as typeof import('os');
/** Per vault, in the temp folder: present while a system OCR process runs (and MARKER_LINGER after). */
const markerPath = (appId: string) => nodePath().join(nodeOs().tmpdir(), `enhanced-canvas-ocr-running-${appId}`);
/** Per computer, somewhere not synced, roaming or cleaned up: %LOCALAPPDATA% on Windows, Application Support on macOS. */
function killPath() {
    const { join } = nodePath(), os = nodeOs();
    const base = Platform.isWin ? process.env.LOCALAPPDATA
        : Platform.isMacOS ? join(os.homedir(), 'Library', 'Application Support') : undefined;
    return join(base || os.tmpdir(), 'obsidian-enhanced-canvas', 'ocr-killed.json');
}
function readKill(): KillVerdict | null {
    try {
        const v = JSON.parse(nodeFs().readFileSync(killPath(), 'utf8'));
        return typeof v?.kills === 'number' && v.kills > 0 ? { kills: v.kills, continued: v.continued === true } : null;
    } catch { return null; } // none yet (or unreadable: same as before this guard existed)
}
function writeKill(v: KillVerdict) {
    try {
        const fs = nodeFs(), p = killPath();
        fs.mkdirSync(nodePath().dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(v));
    } catch (e) { console.error('Enhanced Canvas OCR: saving the crash guard failed', e); }
}
const unlinkQuiet = (p: string) => { try { nodeFs().unlinkSync(p); } catch { /* already gone */ } };

// Windows OCR puts a space between CJK characters; drop it so "中文" matches.
const CJK_GAP = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯])/gu;

/**
 * Optional: on desktop, OCR every vault image into an index kept in the plugin folder (no notes are
 * created): macOS Vision, Windows OCR, or the built-in OCR (Linux, or Windows by choice); on every
 * device, a vault-wide "Search text in images and PDFs" modal and image matches for Find in canvas.
 * Desktop also shares its image entries through files in the config folder (saveShared), which every
 * device reads (loadShared). Mobile only reads: those files and the synced index.
 */
export class ImageTextSearch {
    /** What this device read (and, until IndexedDB, what ocr-index brought in). Searches go through entryOf(). */
    index: OcrIndex = {};
    /** Other devices' shared image text, by device id (loadShared). Read-only here. */
    remote = new Map<string, SharedDevice>();
    private sharedLoading: Promise<void> | null = null;
    private sharedSeen = new Map<string, string>(); // device id → its files' mtimes when last read, read or not
    private own: OwnShared | null = null; // this device's shared files, known after the first write (desktop)
    private sharedTimer: number | null = null; // pending saveShared()
    private rebuilding = false; // rebuild() emptied the index and its scan hasn't started
    private enabled = false;
    private refs: EventRef[] = [];
    private ribbon: HTMLElement | null = null;
    private proc: ChildProcess | null = null;
    private scanning = false;
    private rescan = false;
    private gen = 0; // bumped by disable(), so a scan can tell its OCR process was killed on purpose
    private failed = new Map<string, number>(); // path → mtime this device couldn't read; retried once the file changes, on Rebuild, or (images) on an engine switch
    // Images the user asked to read again with the engine now chosen (rereadImages). Device-local, not a change to the
    // synced index: marking entries stale there would make every other device re-read them too.
    private reread = new Set<string>();
    private rereadNotice: Notice | null = null; // the open "read again" offer, replaced by the next engine switch
    // The engines that have read an image on this device: that engine works here, and another one's text may be worth
    // reading again after a switch. Not the index: its entries may come from another device.
    private readBy = new Set<OcrEngine>();
    // The system OCR itself failed: its images are skipped until Rebuild, so each change doesn't burn a new batch (or,
    // under EDR, raise a new alert). Kept on the device, so a restart doesn't start PowerShell again.
    private broken = false;
    private blockedBy: OcrBlock | null = null; // the known reason for `broken`, shown in the notice
    private builtinBroken = false; // same for the built-in OCR, for this run only (a later download or Rebuild retries)
    private blockNoticed = false; // the "reading images is paused" notice was shown this run (at most once)
    private offerNoticed = false; // the built-in OCR download offer was shown, or a download started, this run
    private silentRuns = 0; // Windows runs in a row that failed with no error text and weren't killed by us: a likely EDR kill
    private pdfLockChecked = false; // earlier builds indexed a locked PDF as empty: the first scan re-reads empty PDFs once
    private markerTimer: number | null = null; // pending removal of the crash marker (MARKER_LINGER)
    private saving: Promise<void> = Promise.resolve();
    private saveQueued = false;
    private loadedAt: number[] = []; // per shard: mtime of the file last read or written
    private dirty = new Set<number>(); // shards changed since the last save
    private builtin = new BuiltinOcr(this.plugin);

    constructor(readonly plugin: EnhancedCanvas) {}

    /** Desktop reads images and PDFs; mobile searches the index that sync brings over. */
    static get canIndex() { return Platform.isDesktopApp; }

    /** The engine choice is offered only on Windows: macOS always uses Vision, Linux always the built-in OCR. */
    static get canChooseEngine() { return Platform.isWin && Platform.isDesktopApp; }

    /** What ENGINE_KEY holds; null = never chosen on this device. */
    private get storedEngine(): OcrEngine | null {
        const v = this.plugin.app.loadLocalStorage(ENGINE_KEY);
        return v === 'builtin' || v === 'system' ? v : null;
    }

    /**
     * Which OCR reads images on this device (docs/design-builtin-ocr.md, decision 5). Windows defaults to the built-in
     * OCR, also after an update from a build that only had Windows OCR: PowerShell starts only by the user's choice.
     */
    get engine(): OcrEngine {
        if (Platform.isMacOS) return 'system';
        if (!Platform.isWin) return 'builtin';
        return this.storedEngine ?? 'builtin';
    }

    /** The current engine failed as a whole: images wait (PDFs go on). */
    private get paused() { return this.engine === 'builtin' ? this.builtinBroken : this.broken; }

    private pause() {
        if (this.engine === 'builtin') this.builtinBroken = true;
        else this.broken = true;
    }

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
        // A normal quit isn't a kill. Sync: nothing async finishes once Obsidian quits. Not always fired (forced
        // shutdown), so a leftover marker only asks (noticeKilled), never decides alone.
        this.plugin.registerEvent(this.plugin.app.workspace.on('quit', () => this.clearMarker()));
        // Also a reload ("Reload app without saving") or closing this vault's window, which may fire no `quit`. A kill
        // fires neither. The main window only: the plugin lives there, a pop-out closing ends nothing.
        this.plugin.registerDomEvent(window, 'beforeunload', () => this.clearMarker());
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
        if (ImageTextSearch.canIndex) {
            this.loadDevice();
            this.checkMarker();
            this.applyKill();
        }

        this.plugin.addCommand({ id: COMMAND_ID, name: 'Search text in images and PDFs', callback: this.open });
        this.plugin.addCommand({ id: CLEAN_SHARED_ID, name: 'Remove image text from other devices…', callback: this.openCleanShared });
        this.ribbon = this.plugin.addRibbonIcon('scan-text', 'Search text in images and PDFs', this.open);
        await this.loadShared();
        if (gen !== this.gen) return;
        this.setCoreSearch();
        // Search-only devices never write the index: the indexing computer owns the file.
        if (!ImageTextSearch.canIndex) return;
        this.plugin.addCommand({ id: REBUILD_ID, name: 'Rebuild image and PDF text index', callback: () => void this.rebuild() });
        this.plugin.addCommand({ id: UNLOCK_ID, name: 'Unlock password-protected PDFs for text search', callback: this.openUnlock });
        if (!Platform.isMacOS) this.plugin.addCommand({ id: REMOVE_BUILTIN_ID, name: 'Remove downloaded built-in OCR files', callback: () => void this.removeBuiltin() });

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
                    this.scheduleShared();
                }),
                app.vault.on('rename', (f, old) => {
                    if (!this.index[old]) return;
                    this.put(f.path, this.index[old]);
                    this.put(old);
                    void this.save();
                    this.scheduleShared();
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
        this.plugin.removeCommand(CLEAN_SHARED_ID);
        this.plugin.removeCommand(REBUILD_ID);
        this.plugin.removeCommand(UNLOCK_ID);
        this.plugin.removeCommand(REMOVE_BUILTIN_ID);
        this.stopOcr();
        // Dropped, not written: the scan after the next enable() schedules it again, and saveShared() compares with the files.
        if (this.sharedTimer !== null) window.clearTimeout(this.sharedTimer);
        this.sharedTimer = null;
        // We killed the process ourselves: a plugin reload or a toggle off/on must not find the marker and call it a crash.
        this.clearMarker();
    }

    /** `app.appId`: what Obsidian keys each vault's localStorage with; stays the same when the vault folder moves. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private get appId(): string { return (this.plugin.app as any).appId ?? 'default'; }

    /** Removes this vault's crash marker now (sync), cancelling a pending delayed removal. */
    private clearMarker() {
        if (this.markerTimer !== null) window.clearTimeout(this.markerTimer);
        this.markerTimer = null;
        if (ImageTextSearch.canIndex) unlinkQuiet(markerPath(this.appId));
    }

    /**
     * At startup: a marker left behind means Obsidian was closed while the system OCR ran (killed, most likely by EDR,
     * or a quit that fired no `quit` event). Recorded for the whole computer; the user decides in noticeKilled().
     * Only ocrImagesNative() writes the marker, so it means the system OCR ran. Not when the built-in OCR is chosen now
     * (the user switched since). Engine empty on Windows: 'system' was saved to localStorage, which Chromium flushes
     * later, but the kill came first — the synchronously written marker outlived it. Restore the choice, so this vault
     * shows noticeKilled() instead of quietly offering the built-in OCR's download, and record the kill.
     */
    private checkMarker() {
        const p = markerPath(this.appId);
        if (!nodeFs().existsSync(p)) return;
        unlinkQuiet(p);
        if (ImageTextSearch.canChooseEngine && this.storedEngine === null) this.plugin.app.saveLocalStorage(ENGINE_KEY, 'system');
        if (this.engine === 'builtin') return;
        const prev = readKill();
        // A kill while the user had chosen to go on counts again; one already pending (another vault found it) doesn't.
        if (prev && !prev.continued) return;
        writeKill({ kills: (prev?.kills ?? 0) + 1, continued: false });
        console.warn('Enhanced Canvas OCR: Obsidian was closed while text recognition was running; it stays off until you choose.');
    }

    /** Mirrors the device-wide verdict into `broken`, so every vault on this computer pauses (or resumes) alike. */
    private applyKill() {
        const kill = readKill();
        if (kill && !kill.continued) {
            if (this.blockedBy === 'killed') return;
            this.broken = true;
            this.blockedBy = 'killed';
            this.saveDevice();
        } else if (this.blockedBy === 'killed') {
            this.broken = false;
            this.blockedBy = null;
            this.saveDevice();
        }
    }

    /** The system OCR was killed along with Obsidian and is off until the user allows it again. */
    get systemKilled() { return ImageTextSearch.canIndex && !Platform.isLinux && readKill()?.continued === false; }

    /**
     * "Keep using Windows OCR" (noticeKilled), or "Try again" in settings: the system OCR may start again on this computer,
     * and this vault uses it. On Windows the engine may be built-in (the default, or the user switched after the kill):
     * the answer means the system OCR, so it's set.
     */
    allowSystemAgain() {
        const kill = readKill();
        if (kill) writeKill({ ...kill, continued: true });
        this.applyKill();
        this.blockNoticed = false;
        if (ImageTextSearch.canChooseEngine && this.engine !== 'system') this.setEngine('system'); // scans
        else if (this.enabled) void this.scan();
    }

    /** Kills the running OCR process or worker. Callers bump `gen` first, so the scan drops that batch instead of failing it. */
    private stopOcr() {
        this.proc?.kill();
        this.proc = null;
        this.builtin.dispose();
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
        this.reread = new Set(Array.isArray(d?.reread) ? d.reread.filter((p: unknown): p is string => typeof p === 'string') : []);
        // Builds before `readBy` kept one flag, `readImage`: the engine chosen then read those images, and with none
        // chosen on Windows it was Windows OCR (the only engine before the choice existed).
        const by: unknown[] = Array.isArray(d?.readBy) ? d.readBy
            : d?.readImage === true ? [ImageTextSearch.canChooseEngine ? this.storedEngine ?? 'system' : this.engine] : [];
        this.readBy = new Set(by.filter((e): e is OcrEngine => e === 'builtin' || e === 'system'));
        this.pdfLockChecked = d?.pdfLockChecked === true;
        this.broken = d?.broken === true;
        this.blockedBy = this.broken && isOcrBlock(d?.blockedBy) ? d.blockedBy : null;
    }

    private saveDevice() {
        this.plugin.app.saveLocalStorage(DEVICE_KEY, {
            failed: Object.fromEntries(this.failed), reread: [...this.reread], readBy: [...this.readBy], pdfLockChecked: this.pdfLockChecked,
            broken: this.broken, blockedBy: this.blockedBy,
        });
    }

    /** Picks up files sync replaced: other devices' shared image text, and on search-only devices the index. */
    async refresh() {
        if (!this.enabled) return;
        if (!ImageTextSearch.canIndex) await this.load();
        await this.loadShared();
    }

    /** This device's id in its shared file names; null until its first write. */
    private get storedId(): string | null {
        const v = this.plugin.app.loadLocalStorage(SHARED_ID_KEY);
        return typeof v === 'string' && /^[0-9a-f]+$/.test(v) ? v : null;
    }

    private newId() {
        const id = randomId();
        this.plugin.app.saveLocalStorage(SHARED_ID_KEY, id);
        return id;
    }

    /** Shown in the cleanup command, and how a copied id is noticed (ownShared). */
    private get deviceName() {
        try { const h = nodeOs().hostname(); if (h) return h; } catch { /* below */ }
        return Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'Computer';
    }

    /** Shared files in the config folder's top level, by device id. */
    private async listShared() {
        const { adapter, configDir } = this.plugin.app.vault;
        const out: SharedList = new Map();
        for (const path of (await adapter.list(configDir)).files) {
            const m = SHARED_FILE.exec(path.slice(path.lastIndexOf('/') + 1));
            if (!m) continue;
            const files = out.get(m[1]) ?? [];
            files.push({ path, part: m[2] });
            out.set(m[1], files);
        }
        return out;
    }

    /**
     * Reads the other devices' shared files that changed since the last read (all devices; this one's are skipped).
     * A device whose files fail to read (mid-sync, damaged, another device's id inside) keeps what was read before.
     * Calls made while one runs share it.
     */
    loadShared() {
        return this.sharedLoading ??= this.readShared().finally(() => (this.sharedLoading = null));
    }

    private async readShared() {
        const { adapter } = this.plugin.app.vault;
        let listed: SharedList;
        try { listed = await this.listShared(); } catch (e) { console.warn('Enhanced Canvas OCR: listing shared image text failed', e); return; }
        const self = this.own?.id ?? this.storedId;
        listed.delete(self ?? '');
        for (const id of [...this.remote.keys()]) if (!listed.has(id)) this.remote.delete(id); // removed (cleanup command)
        for (const id of [...this.sharedSeen.keys()]) if (!listed.has(id)) this.sharedSeen.delete(id);
        for (const [id, list] of listed) {
            try {
                const files: Record<string, number> = {};
                for (const { path } of list) {
                    const s = await adapter.stat(path);
                    if (s) files[path] = s.mtime;
                }
                const sig = JSON.stringify(files);
                if (this.sharedSeen.get(id) === sig) continue; // read before (or failed before: not again until it changes)
                this.sharedSeen.set(id, sig);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const docs: { part: string | undefined; d: any }[] = [];
                for (const { path, part } of list) {
                    if (!(path in files)) continue;
                    const d = JSON.parse(await adapter.read(path));
                    if (d?.v !== 1 || d.device !== id || typeof d.entries !== 'object' || !d.entries) throw new Error(`not ${id}'s shared file: ${path}`);
                    docs.push({ part, d });
                }
                if (!docs.length) continue;
                // A delta alone (mid-sync: it's small and arrives first, or the base is being replaced) isn't the device's text.
                if (!docs.some((x) => x.part === undefined)) throw new Error(`no base file yet for ${id}`);
                // The base, then the delta: its `removed` first, then its entries over the base.
                const entries = new Map<string, SharedEntry>();
                const add = (d: { writtenAt: unknown; entries: Record<string, unknown> }) => {
                    const w = typeof d.writtenAt === 'number' ? d.writtenAt : 0;
                    for (const [p, e] of Object.entries(d.entries) as [string, OcrEntry][]) {
                        if (typeof e?.m === 'number' && Array.isArray(e.l)) entries.set(p, { e: { m: e.m, l: e.l }, w });
                    }
                };
                const delta = docs.find((x) => x.part === 'new')?.d;
                for (const { part, d } of docs) if (part !== 'new') add(d);
                if (delta) {
                    if (Array.isArray(delta.removed)) for (const p of delta.removed) entries.delete(p);
                    add(delta);
                }
                const name = String((delta ?? docs[0].d).name ?? '');
                const writtenAt = Math.max(...docs.map(({ d }) => (typeof d.writtenAt === 'number' ? d.writtenAt : 0)));
                this.remote.set(id, { name, writtenAt, files, entries });
            } catch (e) {
                console.warn('Enhanced Canvas OCR: reading shared image text failed; keeping the last read', id, e);
            }
        }
    }

    /** Writes this device's shared file DELAY after the last change (desktop). */
    private scheduleShared() {
        if (!ImageTextSearch.canIndex || !this.enabled) return;
        if (this.sharedTimer !== null) window.clearTimeout(this.sharedTimer);
        this.sharedTimer = window.setTimeout(() => {
            this.sharedTimer = null;
            // In the save queue: writes never overlap, with each other or with the index's.
            this.saving = this.saving.then(() => this.saveShared());
        }, SHARED_DELAY);
    }

    /**
     * This device's shared files as on disk, read once per run. A `name` other than this computer's means the id came
     * along in a copied profile (migration, disk or VM clone): this computer takes a new id and leaves those files to
     * the one they belong to.
     */
    private async ownShared(): Promise<OwnShared> {
        const { adapter } = this.plugin.app.vault;
        const id = this.storedId;
        const own: OwnShared = { id: id ?? this.newId(), base: new Map(), delta: null, files: new Map() };
        if (!id) return own;
        const list = (await this.listShared()).get(id) ?? [];
        try {
            for (const { path, part } of list) {
                const s = await adapter.stat(path);
                own.files.set(path, s?.mtime ?? -1);
                const d = JSON.parse(await adapter.read(path));
                if (d?.v !== 1 || d.device !== id || typeof d.entries !== 'object' || !d.entries) throw new Error(`damaged: ${path}`);
                if (typeof d.name === 'string' && d.name !== this.deviceName) {
                    console.info(`Enhanced Canvas OCR: this device's shared image text file belongs to "${d.name}"; taking a new id.`);
                    return { id: this.newId(), base: new Map(), delta: null, files: new Map() };
                }
                const items = Object.entries(d.entries as OcrIndex).map(([p, e]) => [p, entryJson(e)] as const);
                if (part !== 'new') for (const [p, j] of items) own.base.set(p, j);
                else own.delta = deltaBody(items.map(([p, j]) => `${JSON.stringify(p)}:${j}`), Array.isArray(d.removed) ? d.removed : []);
            }
        } catch (e) {
            // Unknown content: every file counts as changed, so the next write replaces them all.
            console.warn('Enhanced Canvas OCR: reading this device\'s shared image text failed; it will be rewritten', e);
            own.base.clear();
            own.delta = null;
            for (const p of own.files.keys()) own.files.set(p, -1);
        }
        return own;
    }

    /**
     * Writes this device's image entries for other devices (§5.4): normally only the delta, against the base as last
     * written; past DELTA_BYTES, or when a base file is missing or changed, a new base and then an empty delta (that
     * order: a device reading the new base with the old delta still gets every entry). Skipped when nothing changed
     * and the files are as this device left them, so files removed by another device's cleanup come back.
     */
    private async saveShared() {
        if (!this.enabled || !ImageTextSearch.canIndex) return;
        // A rebuild may have emptied the index; the scan's end schedules this again.
        if (this.scanning || this.rebuilding) return;
        const { adapter } = this.plugin.app.vault;
        try {
            const own = this.own ??= await this.ownShared();
            if (!this.enabled) return;
            // Snapshot without an await before it, in path order so the same entries give the same text.
            const now = new Map<string, string>();
            for (const p of Object.keys(this.index).sort()) {
                const e = this.index[p];
                if (isImagePath(p) && !e.pw) now.set(p, entryJson(e));
            }
            if (!now.size && !own.files.size) return; // nothing read, nothing written yet
            const name = this.deviceName;
            const head = (writtenAt: number) => `{"v":1,"device":${JSON.stringify(own.id)},"name":${JSON.stringify(name)},"writtenAt":${writtenAt},`;
            const deltaPath = this.sharedPath(own.id, 'new');
            const write = async (path: string, text: string) => {
                await adapter.write(path, text);
                own.files.set(path, (await adapter.stat(path))?.mtime ?? -1);
            };
            const unchanged = async (path: string) => {
                const m = (await adapter.stat(path))?.mtime;
                return m !== undefined && m === own.files.get(path);
            };

            const baseFiles = [...own.files.keys()].filter((p) => p !== deltaPath);
            let merge = !baseFiles.length;
            for (const p of baseFiles) if (!merge && !(await unchanged(p))) merge = true;
            if (!merge) {
                const changed: string[] = [];
                for (const [p, j] of now) if (own.base.get(p) !== j) changed.push(`${JSON.stringify(p)}:${j}`);
                const removed = [...own.base.keys()].filter((p) => !now.has(p));
                const body = deltaBody(changed, removed);
                if (body === own.delta && await unchanged(deltaPath)) return;
                const text = `${head(Date.now())}${body}}`;
                if (utf8Bytes(text) <= DELTA_BYTES) {
                    await write(deltaPath, text);
                    own.delta = body;
                    return;
                }
            }
            // Merge: the base in parts of at most PART_BYTES, by path, so one path is in one file.
            const writtenAt = Date.now();
            const parts: string[][] = [[]];
            let size = utf8Bytes(head(writtenAt)) + 16;
            for (const [p, j] of now) {
                const item = `${JSON.stringify(p)}:${j}`, n = utf8Bytes(item) + 1;
                if (parts[parts.length - 1].length && size + n > PART_BYTES) { parts.push([]); size = utf8Bytes(head(writtenAt)) + 16; }
                parts[parts.length - 1].push(item);
                size += n;
            }
            const paths = parts.map((_, i) => this.sharedPath(own.id, i));
            for (let i = 0; i < parts.length; i++) await write(paths[i], `${head(writtenAt)}"entries":{${parts[i].join(',')}}}`);
            own.base = new Map(now);
            for (const p of baseFiles) {
                if (paths.includes(p)) continue;
                if (await adapter.exists(p)) await adapter.remove(p); // fewer parts than before
                own.files.delete(p);
            }
            const empty = deltaBody([], []);
            await write(deltaPath, `${head(writtenAt)}${empty}}`);
            own.delta = empty;
        } catch (e) {
            // The files may be half written: the next write replaces them all instead of diffing against them.
            if (this.own) for (const p of this.own.files.keys()) this.own.files.set(p, -1);
            console.error('Enhanced Canvas OCR: saving the shared image text failed', e);
        }
    }

    /** Part 0 is the base file itself; 'new' is the delta. */
    private sharedPath(id: string, part: number | 'new') {
        return `${this.plugin.app.vault.configDir}/enhanced-canvas-ocr.${id}${part === 0 ? '' : `.${part}`}.json`;
    }

    private openCleanShared = () => {
        if (this.enabled) void this.loadShared().then(() => { if (this.enabled) new SharedCleanupModal(this).open(); });
    };

    /** Deletes other devices' shared files (the cleanup command). Never this device's own. */
    async removeShared(ids: string[]) {
        const { adapter } = this.plugin.app.vault;
        let failed = 0;
        for (const id of ids) {
            const d = this.remote.get(id);
            if (!d || id === this.own?.id) continue;
            try {
                for (const p of Object.keys(d.files)) if (await adapter.exists(p)) await adapter.remove(p);
                this.remote.delete(id);
            } catch (e) {
                failed++;
                console.error('Enhanced Canvas OCR: removing shared image text failed', id, e);
            } finally {
                // Read again whatever is there next: files synced back with their old mtimes, or the ones left by a failure.
                this.sharedSeen.delete(id);
            }
        }
        if (this.inCoreSearch) this.setCoreSearch();
        return failed;
    }

    /**
     * The entry search and display use for `path` (§5.4): this device's own if it matches the file's mtime; else a
     * shared one that matches, the latest written; else the latest written shared one; else this device's.
     */
    entryOf(path: string): OcrEntry | null {
        const local = this.index[path];
        if (!this.remote.size) return local ?? null;
        const f = this.plugin.app.vault.getAbstractFileByPath(path);
        const m = f instanceof TFile ? f.stat.mtime : undefined;
        if (local && local.m === m) return local;
        let best: SharedEntry | null = null, bestMatches = false;
        for (const d of this.remote.values()) {
            const s = d.entries.get(path);
            if (!s) continue;
            const matches = s.e.m === m;
            if (!best || (matches && !bestMatches) || (matches === bestMatches && s.w > best.w)) { best = s; bestMatches = matches; }
        }
        return best?.e ?? local ?? null;
    }

    /** Whether any entry, this device's or shared, exists for `path`. */
    private hasEntry(path: string) {
        if (path in this.index) return true;
        for (const d of this.remote.values()) if (d.entries.has(path)) return true;
        return false;
    }

    /** Every path with an entry, this device's or shared. */
    private entryPaths() {
        const paths = new Set(Object.keys(this.index));
        for (const d of this.remote.values()) for (const p of d.entries.keys()) paths.add(p);
        return paths;
    }

    /** A phone with no image text from any computer yet: the search modal says where it comes from. */
    get waitingForImages() {
        return !ImageTextSearch.canIndex && !this.remote.size && !Object.keys(this.index).some(isImagePath);
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
        this.stopOcr();
        this.index = Object.fromEntries(Object.entries(this.index).filter(([, e]) => e.pw === 'unlocked'));
        for (let s = 0; s < SHARDS; s++) this.dirty.add(s);
        this.failed.clear();
        this.reread.clear();
        this.broken = false;
        this.blockedBy = null;
        this.builtinBroken = false;
        this.blockNoticed = false;
        this.saveDevice();
        // Not the crash guard: Rebuild would start the system OCR again on a computer where it killed Obsidian.
        this.applyKill();
        this.silentRuns = 0;
        // Until scan() sets `scanning`: a shared write already queued would otherwise write the emptied index.
        this.rebuilding = true;
        try {
            await this.save();
        } finally {
            this.rebuilding = false;
        }
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
            if (this.reread.has(f.path)) return true;
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
                const lostReread = [...this.reread].filter((p) => !isImageFile(vault.getAbstractFileByPath(p)) || excluded(p));
                lostReread.forEach((p) => this.reread.delete(p));
                if (lost.length || lostReread.length) this.saveDevice();

                const all = vault.getFiles().filter((f) => isIndexedFile(f) && !excluded(f.path) && stale(f));
                // Built-in OCR without its files: images wait for the download (not failed), PDFs go on.
                const missing = this.engine === 'builtin' && !(await this.builtin.assets.ready());
                if (gen !== this.gen) continue; // `while` rechecks rescan: stopped, or restarted on another engine
                // Updated from a build that only had Windows OCR: it read images here and no engine was ever chosen. The
                // built-in OCR is about to read its first batch, which is an engine switch: setEngine() retries the images
                // Windows OCR failed on, offers reading the others again, and scans again.
                if (!missing && ImageTextSearch.canChooseEngine && this.storedEngine === null && this.readBy.has('system')) {
                    this.setEngine('builtin');
                    continue;
                }
                const skipImages = this.paused || missing;
                if (skipImages && all.some((f) => !isPdf(f))) {
                    if (this.paused) this.noticePaused();
                    else this.offerDownload();
                }
                const todo = skipImages ? all.filter(isPdf) : all;
                const notice = todo.length > BATCH || todo.filter(isPdf).length > PDF_BATCH ? new Notice('', 0) : null;
                let warned = false;
                try {
                    for (let i = 0, n = 0; i < todo.length && gen === this.gen; i += n) {
                        notice?.setMessage(`Enhanced Canvas: reading text in images and PDFs ${i} / ${todo.length}`);
                        let pdfs = 0;
                        const max = this.engine === 'builtin' ? this.builtin.batchSize : BATCH; // per batch: WASM vs WebGPU is known once the worker runs
                        for (n = 0; i + n < todo.length && n < max && pdfs < PDF_BATCH; n++) if (isPdf(todo[i + n])) pdfs++;
                        const batch = todo.slice(i, i + n);
                        // Taken before OCR: an image changed mid-run must still look stale afterwards.
                        const mtimes = batch.map((f) => f.stat.mtime);
                        const lines = await this.ocr(batch, gen);
                        if (gen !== this.gen) break; // disabled: the OCR process was killed, not a failure

                        let bad = 0, badCodec = 0;
                        batch.forEach((f, j) => {
                            const l = lines[j];
                            if (l === undefined) return; // an image skipped while OCR is broken
                            this.reread.delete(f.path); // read again, or failed with this engine (then `failed` holds it)
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
        this.scheduleShared();
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
     * Images through the system OCR (osascript on macOS, PowerShell on Windows) or the built-in one, PDFs through pdf.js; in the order given.
     * null = could not read that file; undefined = an image skipped because OCR is paused, or anything after `gen` changed.
     * 'locked' = a PDF that needs a password.
     */
    private async ocr(files: TFile[], gen: number): Promise<(OcrLine[] | null | undefined | 'locked')[]> {
        const engine = this.engine;
        const system = engine === 'system';
        const wasBroken = this.broken;
        const skip = () => this.paused;
        const images = skip() ? [] : files.filter((f) => !isPdf(f));
        let read = images.length ? await this.ocrImages(images) : [];
        // One bad image fails the whole run: retry one by one so it can't block the rest.
        if (!read && images.length > 1 && !this.paused) {
            read = [];
            let crashed = 0; // runs that failed as a whole, not one image the run reported as unreadable
            let silent = 0; // of those, Windows runs that ended with no error text (see silentRuns)
            for (const f of images) {
                if (gen !== this.gen) return [];
                if (this.paused) break;
                const one = await this.ocrImages([f]);
                if (!one) { crashed++; if (this.silentRuns) silent++; }
                read.push(one?.[0] ?? null);
                // ponytail: the first 3 runs (or all of a smaller batch) failing = OCR is broken, not the images; saves up to ~18 min of retries.
                // Later failures in a row are not checked: each is retried and marked failed on its own.
                if (crashed === read.length && (read.length === 3 || read.length === images.length)) {
                    this.pause();
                    // Every run died without a word: EDR terminating the process leaves no AMSI text to match.
                    if (system && Platform.isWin && silent === crashed && !this.blockedBy) this.blockedBy = 'stopped';
                    break;
                }
            }
        }
        if (gen !== this.gen) return [];
        // One image per run never reaches the retries above (a pasted screenshot): 3 silent runs in a row, across scans, also pause.
        if (system && !this.broken && this.silentRuns >= 3) {
            this.broken = true;
            if (!this.blockedBy) this.blockedBy = 'stopped';
        }
        if (read?.some(Boolean)) this.readBy.add(engine);
        // Every image failing means OCR itself is broken: pause images instead of marking them all failed. PDFs go on.
        // Only formats that always decode count: a batch of HEIC without the codec fails with OCR working fine.
        // Not once this engine ever read an image on this device (readBy, not the index: it may be synced from another
        // device): then OCR works and these files are bad (corrupt, or not really images). Per engine: Windows OCR
        // working says nothing about the built-in one.
        // ocrImages() also sets broken for a known block (no OCR language, policy, antivirus), even for a single image.
        const decodable = images.flatMap((f, j) => (ALWAYS_DECODABLE.test(f.extension) ? [j] : []));
        if (decodable.length > 1 && decodable.every((j) => !read?.[j]) && !this.readBy.has(engine)) {
            console.warn('Enhanced Canvas OCR: no image could be read, pausing image OCR:', decodable.map((j) => images[j].path));
            this.pause();
        }
        if (this.broken !== wasBroken) this.saveDevice(); // now, not after the batch: a restart mid-PDFs must not retry PowerShell
        if (images.length && this.paused) this.noticePaused();
        const out: (OcrLine[] | null | undefined | 'locked')[] = [];
        let k = 0;
        for (const f of files) {
            if (gen !== this.gen) break;
            out.push(isPdf(f) ? await this.readPdf(f, gen) : skip() ? undefined : read?.[k++] ?? null);
        }
        return out;
    }

    /** "Reading images is paused", at most once per run (a paused state read back at startup counts too). */
    private noticePaused() {
        if (this.blockNoticed) return;
        this.blockNoticed = true;
        if (this.engine !== 'builtin' && this.blockedBy === 'killed') { this.noticeKilled(); return; }
        const rebuild = 'Then run "Rebuild image and PDF text index".';
        if (this.engine === 'builtin') {
            new Notice(`Enhanced Canvas: the built-in OCR isn't working, so reading images is paused. PDFs are still indexed. See the developer console (Ctrl+Shift+I) for the error. ${rebuild}`, 0);
            return;
        }
        const why = this.blockedBy ? BLOCK_HINT[this.blockedBy] : 'See the developer console (Ctrl+Shift+I) for the error.';
        if (!ImageTextSearch.canChooseEngine) {
            new Notice(`Enhanced Canvas: macOS OCR isn't working, so reading images is paused. ${why} ${rebuild}`, 0);
            return;
        }
        // Windows: offer the built-in OCR, which doesn't start PowerShell. With no OCR language, both ways are listed.
        const notice = new Notice(createFragment((el) => {
            el.appendText(`Enhanced Canvas: Windows OCR isn't working, so reading images is paused. ${why} `);
            el.appendText(this.blockedBy === 'no-language'
                ? `${rebuild} Or use the built-in OCR instead, which needs no language pack: `
                : 'Use the built-in OCR instead: it runs inside Obsidian, without PowerShell. ');
            el.createEl('button', { text: `Use built-in OCR (${MB(ASSETS_BYTES)} MB download)` }).addEventListener('click', (e) => {
                e.stopPropagation();
                notice.hide();
                this.setEngine('builtin');
            });
        }), 0);
    }

    /**
     * Obsidian was closed while the system OCR ran (checkMarker). Asks rather than decides: a user who quit mid-run
     * leaves the same marker, and "Keep using" puts them back. After a second kill that "Keep using" led to, only the
     * built-in OCR is offered; trying the system OCR again takes the button in settings. Never switches by itself:
     * this user may have just declined the download.
     */
    private noticeKilled() {
        const name = Platform.isWin ? 'Windows OCR' : 'macOS OCR';
        const final = (readKill()?.kills ?? 1) > 1;
        const notice = new Notice(createFragment((el) => {
            el.appendText(`Enhanced Canvas: Obsidian was closed while ${name} was reading images, possibly by company security software. Reading images is paused so it doesn't happen again; PDFs are still indexed. `);
            if (final) el.appendText(`It happened again after you chose to keep using it. To try once more anyway, use "Try ${name} again" in this plugin's settings. `);
            const button = (text: string, run: () => void) => el.createEl('button', { text }).addEventListener('click', (e) => {
                e.stopPropagation();
                notice.hide();
                run();
            });
            if (ImageTextSearch.canChooseEngine) button(`Use built-in OCR (${MB(ASSETS_BYTES)} MB download)`, () => this.setEngine('builtin'));
            if (!final) button(`Keep using ${name}`, () => this.allowSystemAgain());
        }), 0);
    }

    /**
     * The built-in OCR's files are missing (first use, a file added since, or IndexedDB cleared): offer the download
     * once per run. A notice, not a modal: this comes from a background scan, often at startup, right where the release
     * notes modal opens. Closed without an answer: offered again next run; images wait meanwhile.
     */
    private offerDownload() {
        if (this.offerNoticed) return;
        this.offerNoticed = true;
        const bytes = this.builtin.assets.missingBytes; // scan() just called ready()
        const notice = new Notice(createFragment((el) => {
            // Some files are here already: an update added one (or a download stopped halfway).
            el.appendText(bytes < ASSETS_BYTES
                ? `Enhanced Canvas: the built-in OCR needs one more download of about ${MB(bytes)} MB before it can read new images. PDFs are indexed meanwhile. `
                : `Enhanced Canvas: to read the text in your images, the built-in OCR needs a one-time download of about ${MB(ASSETS_BYTES)} MB. It then runs on your computer. PDFs are indexed meanwhile. `);
            el.createEl('button', { text: 'Download' }).addEventListener('click', (e) => {
                e.stopPropagation();
                notice.hide();
                void this.downloadBuiltin();
            });
            if (ImageTextSearch.canChooseEngine) el.createDiv({ text: 'To use Windows OCR instead (no download, one language; company security software may block it), choose it in settings → OCR engine.' });
        }), 0);
    }

    /**
     * Downloads the built-in OCR's files if they're missing, with a progress notice, then reads the images that waited.
     * Never retried automatically after a failure: the notice has a Retry button, and the next run offers it again.
     */
    async downloadBuiltin() {
        this.offerNoticed = true; // a scan meanwhile must not offer what is already happening
        const { assets } = this.builtin;
        if (!assets.isDownloading && await assets.ready()) {
            if (this.enabled) void this.scan();
            return;
        }
        if (assets.isDownloading) return; // its own notice shows the progress
        const text = (done: number, total: number) => `Enhanced Canvas: downloading built-in OCR: ${MB(done)} / ${MB(total)} MB`;
        const progress = new Notice(text(0, ASSETS_BYTES), 0);
        const r = await assets.download((done, total) => progress.setMessage(text(done, total)));
        progress.hide();
        if (r === 'ok') {
            this.builtinBroken = false;
            if (this.enabled && this.engine === 'builtin') {
                new Notice('Enhanced Canvas: built-in OCR is ready. Reading images…');
                void this.scan();
            } else new Notice('Enhanced Canvas: built-in OCR is ready.');
            return;
        }
        const notice = new Notice(createFragment((el) => {
            el.appendText(`Enhanced Canvas: ${DOWNLOAD_FAILED[r]} `);
            if (r === 'storage') return;
            el.createEl('button', { text: 'Retry' }).addEventListener('click', (e) => {
                e.stopPropagation();
                notice.hide();
                void this.downloadBuiltin();
            });
        }), 0);
    }

    /**
     * Sets this device's engine (Windows only). Images the old engine couldn't read are tried again; images already
     * read keep their text, and a notice offers to read them again (rereadImages). A running scan restarts on the new
     * engine, and choosing the built-in OCR starts its download if needed (an explicit choice: no second ask).
     */
    setEngine(engine: OcrEngine) {
        if (!ImageTextSearch.canChooseEngine) return;
        const other = [...this.readBy].some((e) => e !== engine); // another engine read images here: offer reading them again
        this.plugin.app.saveLocalStorage(ENGINE_KEY, engine);
        this.blockNoticed = false; // the new engine may be paused too: say so once more
        this.gen++; // the running batch is dropped, not failed
        this.stopOcr();
        // An image one engine can't read (a language it lacks, a missing codec) the other may: PDFs don't use OCR.
        const { vault } = this.plugin.app;
        const retry = [...this.failed.keys()].filter((p) => isImageFile(vault.getAbstractFileByPath(p)));
        retry.forEach((p) => this.failed.delete(p));
        this.saveDevice(); // always: also writes a `readBy` that loadDevice() worked out from the engine key just replaced
        if (engine === 'builtin') void this.downloadBuiltin(); // scans once the files are there
        else if (this.enabled) void this.scan();
        if (this.enabled && other) this.offerReread(engine);
        else this.rereadNotice?.hide(); // an open offer names the engine just left
    }

    /** After an engine switch: images already read keep the old engine's text until the user asks to read them again. */
    private offerReread(engine: OcrEngine) {
        const { vault } = this.plugin.app;
        const n = Object.keys(this.index).filter((p) => !this.reread.has(p) && isImageFile(vault.getAbstractFileByPath(p))).length;
        this.rereadNotice?.hide(); // switching back and forth must not stack offers
        if (!n) return;
        const name = engine === 'builtin' ? 'the built-in OCR' : 'Windows OCR';
        const notice = this.rereadNotice = new Notice(createFragment((el) => {
            el.appendText(`Enhanced Canvas: ${n} image${n === 1 ? '' : 's'} already read keep${n === 1 ? 's' : ''} the text from the previous engine. `);
            el.createEl('button', { text: `Read again with ${name}` }).addEventListener('click', (e) => {
                e.stopPropagation();
                notice.hide();
                this.rereadImages();
            });
        }), 0);
    }

    /**
     * Reads every indexed image again with the current engine; PDFs are left alone (no OCR). Their old text stays
     * searchable until each is replaced, and one this engine can't read keeps it. Survives a restart (saveDevice).
     */
    private rereadImages() {
        if (!this.enabled) return;
        const { vault } = this.plugin.app;
        for (const p of Object.keys(this.index)) if (isImageFile(vault.getAbstractFileByPath(p))) this.reread.add(p);
        this.saveDevice();
        void this.scan(); // the built-in OCR without its files: images wait for the download, which scans again
    }

    /** Command: frees the ~60 MB. The engine stays as chosen: the built-in OCR offers the download again, Windows OCR goes on. */
    private async removeBuiltin() {
        if (this.builtin.assets.isDownloading) {
            new Notice('Enhanced Canvas: the built-in OCR is still downloading. Try again once it finishes.');
            return;
        }
        this.gen++;
        this.stopOcr();
        try {
            await this.builtin.assets.clear();
        } catch (e) {
            console.error('Enhanced Canvas OCR (built-in): removing the files failed', e);
            new Notice('Enhanced Canvas: couldn\'t remove the built-in OCR files. See the developer console (Ctrl+Shift+I).');
            return;
        }
        new Notice(`Enhanced Canvas: removed the built-in OCR files from this device.`);
        // A fresh start for the next notices: with the built-in OCR chosen, the download is offered again.
        this.builtinBroken = false;
        this.blockNoticed = false;
        this.offerNoticed = false;
        if (this.enabled) void this.scan();
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

    private async ocrImages(files: TFile[]): Promise<(OcrLine[] | null)[] | null> {
        if (this.engine === 'system') return this.ocrImagesNative(files);
        const gen = this.gen;
        const read = await this.builtin.read(files, () => gen === this.gen);
        // Same CJK_GAP pass as the Windows path. Here, not in BuiltinOcr: that file may only `import type` from this one.
        read?.forEach((l) => l?.forEach((x) => (x[0] = x[0].replace(CJK_GAP, ''))));
        return read;
    }

    private ocrImagesNative(files: TFile[]): Promise<(OcrLine[] | null)[] | null> {
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
        // Checked before every spawn, not only at startup: another vault on this computer may have found a kill since.
        if (readKill()?.continued === false) {
            block('killed');
            return Promise.resolve(null);
        }
        // The crash marker goes to disk before the spawn, synchronously: if EDR kills Obsidian now, it's already there.
        const marker = markerPath(this.appId);
        if (this.markerTimer !== null) window.clearTimeout(this.markerTimer);
        this.markerTimer = null;
        try {
            nodeFs().writeFileSync(marker, String(Date.now()));
        } catch (e) { console.warn('Enhanced Canvas OCR: couldn\'t write the crash marker', e); }
        const ended = (proc: ChildProcess) => {
            // Disabled: disable() already removed it. A newer run: that run owns the marker now.
            if (!this.enabled || (this.proc && this.proc !== proc)) return;
            if (this.markerTimer !== null) window.clearTimeout(this.markerTimer);
            // Not at once: EDR may kill Obsidian just after the process ends, and a one-image run takes about a second.
            this.markerTimer = window.setTimeout(() => { this.markerTimer = null; unlinkQuiet(marker); }, MARKER_LINGER);
        };
        return new Promise((resolve) => {
            const proc = this.proc = Platform.isWin
                ? spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], { timeout, windowsHide: true })
                : spawn('osascript', ['-l', 'JavaScript', '-e', OCR_SCRIPT, ...paths], { timeout });
            if (Platform.isWin) proc.stdin?.end(winOcrScript(paths));
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
                ended(proc);
                // Couldn't start at all: missing, or refused by antivirus / Defender ASR (EPERM, EACCES, UNKNOWN).
                if (Platform.isWin && gen === this.gen) block(e.code === 'ENOENT' ? 'missing' : 'blocked');
                console.error('Enhanced Canvas OCR:', e);
                resolve(null);
            });
            proc.on('close', (code, signal) => {
                if (done) return;
                done = true;
                if (this.proc === proc) this.proc = null;
                ended(proc);
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
                    // `-Command -` exits 0 on a parse-time failure (AMSI rejecting the script included): stderr, no output.
                    if (code !== 0 || (!out.trim() && err.trim())) throw new Error(err || `OCR process exited with ${code ?? signal}`);
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

    /** OCR lines of one image with their normalized text (entryOf); null when off or not indexed. */
    textOf(path: string) {
        const l = this.enabled ? this.entryOf(path)?.l : undefined;
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
        for (const path of this.entryPaths()) {
            const l = this.entryOf(path)?.l;
            if (!l) continue;
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
                if (!this.hasEntry(dest)) continue;
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
        const waiting = this.search.waitingForImages
            ? 'No image text has reached this device yet: a computer with this plugin reads the images, and sync brings the text here.'
            : '';
        this.countEl.setText([count, indexing, waiting].filter(Boolean).join(' · '));
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

/** "Remove image text from other devices…": one row per other device's shared files, removed only when ticked. */
class SharedCleanupModal extends Modal {
    constructor(private search: ImageTextSearch) {
        super(search.plugin.app);
    }

    onOpen() {
        this.setTitle('Remove image text from other devices');
        const { contentEl } = this;
        const devices = [...this.search.remote].sort((a, b) => b[1].writtenAt - a[1].writtenAt);
        if (!devices.length) {
            contentEl.createEl('p', { text: 'No image text from other devices is in this vault.' });
            return;
        }
        contentEl.createEl('p', { text: 'Each computer that reads images shares their text with your other devices. Remove the ones you no longer use. A computer still in use writes its text again the next time it reads images.' });
        const picked = new Set<string>();
        let button!: ButtonComponent;
        for (const [id, d] of devices) {
            const n = d.entries.size;
            new Setting(contentEl)
                .setName(d.name || 'Unnamed device')
                .setDesc(`Last written ${new Date(d.writtenAt).toLocaleString()} · ${n} image${n === 1 ? '' : 's'}`)
                .addToggle((t) => t.onChange((on) => {
                    if (on) picked.add(id); else picked.delete(id);
                    button.setDisabled(!picked.size);
                }));
        }
        new Setting(contentEl).addButton((b) => {
            button = b;
            b.setButtonText('Remove').setWarning().setDisabled(true).onClick(async () => {
                b.setDisabled(true);
                const failed = await this.search.removeShared([...picked]);
                new Notice(failed
                    ? 'Enhanced Canvas: couldn\'t remove some of the image text. See the developer console (Ctrl+Shift+I).'
                    : 'Enhanced Canvas: removed the image text of the selected devices.');
                this.close();
            });
        });
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
