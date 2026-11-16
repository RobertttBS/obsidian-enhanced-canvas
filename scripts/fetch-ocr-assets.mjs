// Maintainer-only: prepares the files for the `ocr-assets-1` GitHub release that the built-in OCR downloads
// (docs/spec-builtin-ocr.md §4). Fetches them from the converted PaddleOCR models and checks each SHA-256; upload
// the folder's three files to the release by hand. Names and hashes must match FILES in src/OcrAssets.ts.
// The onnxruntime .wasm isn't here: it ships inside main.js (esbuild.config.mjs, `ocr-wasm-source`).
// Usage: node scripts/fetch-ocr-assets.mjs <target folder>
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MODELS = "https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main";
const ASSETS = [
	{ name: "det.onnx", url: `${MODELS}/detection/PP-OCRv6_small_det.onnx`, sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e" },
	{ name: "rec.onnx", url: `${MODELS}/recognition/PP-OCRv6_small_rec.onnx`, sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634" },
	{ name: "dict.txt", url: `${MODELS}/recognition/ppocrv6_dict.txt`, sha256: "41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8" },
];

const target = process.argv[2];
if (!target) {
	console.error("Usage: node scripts/fetch-ocr-assets.mjs <target folder>");
	process.exit(1);
}
await mkdir(target, { recursive: true });

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
let failed = false;

for (const a of ASSETS) {
	const dest = path.join(target, a.name);
	if (existsSync(dest) && sha256(await readFile(dest)) === a.sha256) {
		console.log(`skip     ${a.name} (already present)`);
		continue;
	}
	let buf;
	try {
		const res = await fetch(a.url);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		buf = Buffer.from(await res.arrayBuffer());
	} catch (e) {
		console.error(`error    ${a.name}: ${e.message}`);
		failed = true;
		continue;
	}
	const got = sha256(buf);
	if (got !== a.sha256) {
		console.error(`error    ${a.name}: SHA-256 ${got}, expected ${a.sha256}`);
		await rm(dest, { force: true }); // never leave a mismatched file behind
		failed = true;
		continue;
	}
	await writeFile(dest, buf);
	console.log(`ok       ${a.name} (${buf.length.toLocaleString("en-US")} bytes)`);
}

process.exit(failed ? 1 : 0);
