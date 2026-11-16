# Third-party notices

Enhanced Canvas itself is MIT licensed (see `LICENSE`). The released `main.js` also contains the software below, and the built-in OCR downloads the model files listed at the end.

## Bundled in `main.js`

| Package | Version | License | Copyright | Source |
| --- | --- | --- | --- | --- |
| onnxruntime-web (JavaScript and the `ort-wasm-simd-threaded.asyncify.wasm` binary) | 1.31.1 | MIT | Copyright (c) Microsoft Corporation | https://github.com/microsoft/onnxruntime |
| onnxruntime-common | 1.31.1 | MIT | Copyright (c) Microsoft Corporation | https://github.com/microsoft/onnxruntime |
| ppu-paddle-ocr | 6.7.1 | MIT | Copyright (c) 2025 PT. Perkasa Pilar Utama | https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr |
| ppu-ocv | 4.0.1 | MIT | Copyright (c) 2025 PT. Perkasa Pilar Utama | https://github.com/PT-Perkasa-Pilar-Utama/ppu-ocv |
| monkey-around | 3.0.0 | ISC | See the source repository | https://github.com/pjeby/monkey-around |

The onnxruntime WebAssembly binary is built from ONNX Runtime, which includes third-party components of its own. Their notices are in ONNX Runtime's `ThirdPartyNotices.txt`: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt

### MIT License

The MIT-licensed packages above are used under these terms, each with its own copyright line from the table:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Downloaded by the built-in OCR

Not part of `main.js`. Downloaded once, on request, from this project's GitHub release `ocr-assets-1`, and unmodified from the source below.

| File | What it is | License | Source |
| --- | --- | --- | --- |
| `det.onnx` | PP-OCRv6 small, text detection model | Apache-2.0 | `detection/PP-OCRv6_small_det.onnx` |
| `rec.onnx` | PP-OCRv6 small, text recognition model | Apache-2.0 | `recognition/PP-OCRv6_small_rec.onnx` |
| `dict.txt` | Character dictionary for the recognition model | Apache-2.0 | `recognition/ppocrv6_dict.txt` |

- Source paths are in https://huggingface.co/snowfluke/ppu-paddle-ocr-models, the ONNX conversion of the PaddleOCR models.
- The models come from PaddleOCR, Copyright (c) PaddlePaddle Authors: https://github.com/PaddlePaddle/PaddleOCR
- License text: https://www.apache.org/licenses/LICENSE-2.0 (a copy is attached to the `ocr-assets-1` release).
- SHA-256 of each file: `FILES` in `src/OcrAssets.ts`.
