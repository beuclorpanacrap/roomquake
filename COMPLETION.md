# RoomQuake implementation and validation summary

## Delivered

A local-first Node.js/WebSocket server, explicit-consent phone client, host dashboard, virtual sensor array, signal filtering, shared-event detection, and clock-offset estimation. The interface includes guided host/phone onboarding, placement and permission instructions, a pre-flight checklist, measured health indicators, spatial intensity, common-timebase waveforms, event history, sensitivity controls and a lower-power mode. `DESIGN.md` records the design system.

## Latency architecture

Phone samples send immediately. Shared events dispatch synchronously during ingestion. Host-only sequenced telemetry targets 10 ms, with bounded backpressure and metadata reconciliation at 1 Hz. Full histories are reserved for join/reset. Rendering coalesces onto animation frames. Explicit virtual impacts bypass the simulation tick.

## Validation at handoff

- Nine automated tests passed, covering signal/coincidence logic, clock estimation, input validation, authorization, reconnect cleanup, consent gating, immediate sample sending, next-frame event rendering, telemetry cursors and backpressure.
- Production build passed.
- Local benchmark: 300 warmup rounds and 2,000 measured rounds of 24 sensors × 5 samples, with four mock event subscribers; 240,000 measured samples. Processing p95 was approximately 0.038 ms and p99 approximately 0.198 ms. The test fails above a 10 ms p95 budget. Results vary by machine.
- Real loopback WebSocket check: 24 phone clients, 4,800 samples, two shared events, zero errors, and a largest measured host packet of 6,416 bytes.
- Chromium screenshots were visually inspected at 1440×1000, 1024×768, 390×844 and 360×800. Landing, empty/live host, phone invitation, placement/consent, simulated permission denial and lower-power selection were checked. No horizontal overflow was found; the final browser console had no errors or warnings.

Local screenshots, browser artifacts, logs, runtime room codes, credentials and machine-specific handoff details are deliberately excluded from this repository.

## Reproduce

```sh
npm ci
npm test
npm run benchmark
node scripts/stream-check.js
npm run build
npm start
```

See `README.md` for HTTPS and real-phone instructions. Server/library changes require restarting the Node process, which erases ephemeral rooms; reload clients and create a new room. An existing tunnel can retain its configuration if it targets the same server port.

## Limits

The benchmark measures in-process work, not phone-to-screen latency. Browser sensor delivery, network asymmetry, Wi-Fi, public tunnels and display refresh prevent a hard 10 ms end-to-end guarantee. A 60 Hz display has a 16.7 ms frame interval. Physical iOS/Android behavior and cross-device accuracy still require hardware validation. The app shows relative onset/intensity, not reliable localization, earthquake warnings or structural-health assessments.

Motion consent, stop-on-hide/disconnect, bounded memory, secret redaction and ephemeral sessions are preserved. Use trusted networks and non-sensitive names; room membership is not identity verification. Hosts receive array data, while phone clients receive their own setup metadata.
