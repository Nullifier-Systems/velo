# QR Scanner Library Evaluation for Low-End Android

**Status:** Recommended  
**Tested:** 2026-07-18

## Goal

Choose a browser QR scanner for the merchant flow that remains usable on inexpensive Android phones and older browsers. The scanner only needs QR codes, not the larger set of one- and two-dimensional barcode formats.

## Candidates

| Library tested | Version | Compatibility and implementation notes | Low-end suitability |
| --- | --- | --- | --- |
| [`qr-scanner`](https://github.com/nimiq/qr-scanner) | 1.4.2 | Uses native `BarcodeDetector` when present and otherwise decodes in a Web Worker. The normal build uses ES2017 features and dynamic imports; an ES2015 legacy UMD build is provided for older browsers. The library documents a 59.3 kB minified / 16.3 kB gzip fallback payload, or 15.3 kB / 5.6 kB gzip when native detection is available. Camera scanning, rear-camera preference, scan-region downscaling, scan-rate throttling, and torch controls are built in. | Best fit. Worker isolation keeps decoding off the UI thread, the payload is small, and `maxScansPerSecond` plus a downscaled scan region give direct battery/CPU controls. |
| [`@zxing/browser`](https://github.com/zxing-js/browser) | 0.2.1 | Provides camera, stream, image, and video readers plus detailed media constraints and torch controls. It is lower-level and the QR reader decodes on the main thread by default. Its npm package unpacked size was 5.8 MB in the tested release, including sources/dependencies; production tree-shaking reduces the delivered bundle but must be measured after integration. | Fastest raw still-image decoder in this test, but continuous main-thread work risks visible frame drops on weak CPUs unless Velo adds its own worker, frame throttling, and scan-region pipeline. |
| [`html5-qrcode`](https://github.com/mebjas/html5-qrcode) | 2.3.8 | Offers both a ready-made scanner UI and a lower-level API, supports camera and file input, and wraps ZXing-JS. Its published support table covers major Android browsers, but camera support still depends on browser media APIs. Native `BarcodeDetector` integration is explicitly experimental. The package supports many barcode formats that this flow does not need. | Easiest prototype, but the heaviest abstraction and slowest throttled results. Extra UI and multi-format behavior are poor tradeoffs for a QR-only flow on constrained phones. |

Package versions and unpacked sizes were read from npm on the test date. Unpacked package size is not the same as the browser transfer size; the final application bundle should be checked during implementation.

## Performance test

### Method

The three published packages were loaded through Vite in headless Chrome 150 with native `BarcodeDetector` unavailable, forcing their JavaScript fallback paths. Each library decoded the same claim payload from three generated PNG fixtures:

- normal black-on-white, 256 px;
- small black-on-white, 96 px;
- low contrast, 256 px.

After two warm-ups, each library decoded each fixture 15 times. The test was repeated with Chrome DevTools CPU throttling set to 6× as a repeatable proxy for low-end hardware. Times below are median milliseconds; every cell had 15/15 correct decodes.

| CPU profile | Library | Normal | Small | Low contrast |
| --- | --- | ---: | ---: | ---: |
| Unthrottled | `qr-scanner` | 89.8 | 91.0 | 84.2 |
| Unthrottled | `@zxing/browser` | **12.9** | **8.2** | **10.7** |
| Unthrottled | `html5-qrcode` | 65.7 | 41.4 | 50.3 |
| 6× throttle | `qr-scanner` | 95.1 | 80.9 | 155.6 |
| 6× throttle | `@zxing/browser` | **31.7** | **14.4** | **26.2** |
| 6× throttle | `html5-qrcode` | 169.7 | 109.4 | 412.0 |

The result measures still-image decode latency, not camera acquisition. It does not reproduce autofocus, motion blur, poor sensors, thermal throttling, or vendor-specific camera drivers. No physical low-end Android device or camera was available in this environment, so a device acceptance matrix remains a release requirement.

`qr-scanner` pays worker setup/transfer overhead in this one-shot test. Its continuous camera API reuses the worker, canvas, and scan region, so the still-image number should not be interpreted as its camera frame rate. The architectural advantage is that the work does not block React input and animation on the main thread. By contrast, ZXing's strong latency is attractive but its default main-thread execution needs additional engineering before it offers the same responsiveness guarantee.

## Known compatibility issues

These constraints apply before library-specific behavior:

- Camera access through `getUserMedia()` requires HTTPS (localhost is allowed for development), explicit user permission, and a top-level page or an iframe granted camera permission.
- A browser can expose `getUserMedia()` but still ignore the requested rear camera, resolution, focus, zoom, or torch constraint. The UI needs a camera picker/fallback and must not require torch support.
- Very old Android WebViews and browsers without usable `getUserMedia()` cannot provide inline scanning. Keep a file/image upload fallback and a manual claim-code entry path.

Library-specific findings:

- `qr-scanner`'s standard build requires ES2017 and dynamic import. Older targets need its larger ES2015 `qr-scanner.legacy.min.js` build, and Vite must correctly emit/load the worker. Its npm release is old (1.4.2 was last published in 2022), which increases maintenance risk; pin the version and run the device matrix before upgrades or browser-policy changes.
- `@zxing/browser` does not move decode work to a worker automatically. An unrestricted camera loop can monopolize a slow main thread and drain battery. It also exposes more low-level media lifecycle work that Velo would need to own and test.
- `html5-qrcode`'s support table lists inline Android camera support for Chrome, Firefox, Edge, and Opera, but only file-based support for Opera Mini and UC Browser. Its documented iOS camera support starts at iOS 15.1. Its native `BarcodeDetector` path is experimental, so it should not be relied upon as the compatibility fallback.
- All three need a non-camera fallback for embedded in-app browsers that deny camera permission, devices with no rear camera, and users who permanently deny permission.

## Recommendation

Adopt **`qr-scanner` 1.4.2**, initially using its standard worker-backed build, for the merchant scanner.

Configure it for constrained devices:

1. Request `facingMode: "environment"`, but allow camera selection if the browser chooses the wrong lens.
2. Restrict decoding to the visible guide box and downscale that region to roughly 300–400 px.
3. Start at 8–10 scans per second rather than the 25 fps default, then stop the camera immediately after a valid Velo payload is found.
4. Validate and deduplicate the payload before submitting it; a decoded string is untrusted input.
5. Offer image upload and manual entry whenever camera capability, permission, or decoding fails.
6. Lazy-load the scanner only when the merchant opens the scan screen, and destroy it on navigation to release the camera and worker.

Before production release, test at minimum Chrome and Samsung Internet on an Android Go-class device with 2 GB RAM, plus the oldest Android/WebView version Velo promises to support. Test clean print, cracked/dim screen, low light, glare, motion, offline reload, permission denial, wrong-camera selection, background/foreground recovery, and repeated scans. Track time-to-first-decode, dropped UI frames, peak memory, and battery/temperature over a five-minute session.

Choose `@zxing/browser` instead only if physical-device testing shows materially better acquisition reliability and the team is prepared to add a dedicated worker pipeline. Do not choose `html5-qrcode` for this flow unless delivery speed outweighs bundle size and low-end responsiveness.

## Sources

- [`qr-scanner` documentation](https://github.com/nimiq/qr-scanner)
- [`@zxing/browser` documentation](https://github.com/zxing-js/browser)
- [`html5-qrcode` documentation and platform matrix](https://github.com/mebjas/html5-qrcode)
- [MDN: `MediaDevices.getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

