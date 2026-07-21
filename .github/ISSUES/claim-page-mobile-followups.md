# Follow-Up Mobile Counter Usability Issues

This document tracks identified counter usability enhancements and follow-up issues filed during cross-device mobile verification of the Velo Claim page (`ClaimQR`).

---

## Issue #1: High-Sunlight Counter Brightness Mode & Auto-Max Screen Brightness Prompt

### Summary

When a claim QR code is scanned by a merchant at an outdoor physical counter or under high-ambient glare, low-end budget Android LCD screens may have insufficient contrast if screen brightness is dimmed.

### Device Affected

- Older / Budget Android devices (e.g. Moto G, Samsung A-series)

### Visual Evidence

![Budget Android Screenshot](file:///C:/Users/HP/.gemini/antigravity/brain/cf844eee-988c-47e6-93c7-b61c64a6ae6e/claim_page_android_budget_1784510227614.png)

### Proposed Resolution

- Add an optional "High Contrast Counter Mode" button or standard Screen Wake Lock / Brightness hint prompt above the QR box for counter convenience.

---

## Issue #2: iOS Safari Bottom Bar Collapse & Counter Haptic Feedback

### Summary

On iOS Safari, scanning or tapping buttons at a counter can benefit from haptic vibration feedback (`navigator.vibrate`) when the status updates from `locked` to `released`.

### Device Affected

- iOS Safari (iPhone 12 / 13 / 14 / 15 / 16)

### Visual Evidence

![iOS Safari Screenshot](file:///C:/Users/HP/.gemini/antigravity/brain/cf844eee-988c-47e6-93c7-b61c64a6ae6e/claim_page_ios_safari_1784510240844.png)

### Proposed Resolution

- Add Web Vibration API trigger upon status change polling (`status.status === 'released'`).

---

## Issue #3: Ultra-Narrow 280px Feature Phone Screen Density Scaling

### Summary

While 320px screen width is fully supported, KaiOS and feature phones with 280px width screens benefit from hiding secondary debug summary text.

### Device Affected

- Ultra low-resolution 280px screens

### Visual Evidence

![Low Resolution Display Screenshot](file:///C:/Users/HP/.gemini/antigravity/brain/cf844eee-988c-47e6-93c7-b61c64a6ae6e/claim_page_low_res_1784510252409.png)

### Proposed Resolution

- Add `@media (max-width: 300px)` style to collapse non-essential ticket metadata.
