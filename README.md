# RoomQuake

A local-first browser vibration lab: one host dashboard, several consenting phones, and a reproducible virtual array. **Educational hackathon prototype only. Not an earthquake-warning, structural-health, or safety instrument.** It does not model earthquakes or estimate a reliable source location.

## Run

Requires Node.js 20+ and npm. The only runtime dependency is `ws`.

```sh
npm ci
npm start
```

Open **http://localhost:3000**, select **Create a room**, then **Start simulation**. Four virtual sensors appear with an immediate initial impact, seeded noise, and recurring impacts every three seconds. **Send an impact** processes a pulse immediately, without waiting for a simulation tick. Change the noise multiplier or shared-event window to explore detection. Stop/restart simulation to reset its deterministic sample sequence; actual wall-clock scheduling can vary. Virtual onset delays are synthetic, not measured propagation.

```sh
npm run dev        # Node watch mode
npm test           # signal, clock, session, WebSocket integration tests
npm run build      # syntax checks and production directory assembly
node dist/server.js
```

Build output intentionally needs no bundler: browser ES modules, CSS, HTML, and the Node server are copied into `dist/`. Dependencies resolve from the root `node_modules`; if moving `dist` to another directory, run `npm ci --omit=dev` there, then `node server.js`. Only run one server on a port. Override with `PORT=3001 npm start`.

## Real phones on the same network

1. Connect the computer and phones to the same trusted Wi-Fi. Disable client isolation if the network administrator permits it; allow inbound TCP port 3000 in the computer firewall only on that private network.
2. Find the computer's LAN address (for example `192.168.1.25`). **The phone's localhost is the phone itself.**
3. Use trusted HTTPS. HTTP on a LAN IP generally cannot access mobile motion sensors, even though desktop `localhost` can be a secure context. Simply dismissing an invalid-certificate warning is not a reliable solution.
4. Open the host at `https://192.168.1.25:3000`, create a room, and copy its phone join link. Open that link in each phone browser, enter a name, and tap **Join as a sensor**.
5. Tap **Enable motion** and accept the motion permission if prompted (iOS Safari requests it directly from that tap). Choose a column and row, place the phones flat on a common sturdy surface, and keep the pages visible. Gentle nearby footsteps or a light surface tap may register; do not hit phones or fragile furniture.
6. **Stop sensing** removes the motion listener and clears unsent samples. Hiding the page or losing the connection stops collection too. After reconnecting, explicitly enable motion again.

### Safe local HTTPS development option

Use a local development CA such as `mkcert`, installed from its official distribution. Create and trust this CA only on devices you control for this experiment. Example once `mkcert` is installed:

```sh
mkcert -install
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 192.168.1.25
TLS_CERT=localhost.pem TLS_KEY=localhost-key.pem npm start
```

Replace the example IP with the computer's actual address. The server reads these certificate paths and serves both HTTPS and secure WebSockets. Install **only the public root CA certificate** (`rootCA.pem` inside `mkcert -CAROOT`) on each test phone and enable trust for it using that device's settings. On iOS this includes installing the profile and explicitly enabling full trust under Certificate Trust Settings. Never copy `rootCA-key.pem` or the server's private key to another device. Remove the development CA from phones when finished. This setup needs no public tunnel, paid service, browser security flags, or certificate-warning bypass. If you cannot establish trusted HTTPS, use simulation on localhost.

Unsupported devices, denied permission, missing samples, and insecure contexts receive explicit messages. Real iOS/Android hardware permissions still require testing on your own devices; a desktop cannot validate their sensor drivers.

## Architecture and major files

- `server.js`: Node HTTP/optional HTTPS static server and WebSocket protocol; host capabilities, phone reconnect credentials, heartbeat, rate/payload limits, simulation, room expiry.
- `lib/session.js`: ephemeral room/device state; numeric validation; bounded signal and event buffers; snapshots strip secret reconnect credentials.
- `lib/signal.js`: magnitude detrending, robust rolling noise floor, threshold/refractory logic, distinct-device coincidence, low-latency clock-offset estimation.
- `public/index.html`, `public/style.css`, `public/app.js`: responsive host and phone flows, canvas traces on a common server timeline, grid intensity, relative onsets, event list, permission and connection state.
- `test/core.test.js`: meaningful signal, coincidence, clock, validation, and real WebSocket lifecycle tests.
- `test/client.test.js`: browser-controller smoke test with a DOM harness, including consent gating and permission denial.
- `scripts/build.js`: syntax validation and deployable asset assembly.

Phone samples contain timestamp and acceleration magnitude in m/s² and are sent immediately on a valid motion event. The phone sends no motion samples until a user explicitly enables motion. There is no artificial client sampling throttle; actual device cadence varies. The server accepts up to 260 messages per second per socket, including control traffic. Magnitude is detrended with a 300 ms exponential baseline, then compared with `max(0.16 m/s², multiplier × rolling noise)`. Noise uses a winsorized EWMA, with a 650 ms per-sensor refractory period. Shared events require at least two distinct sensors within 50–500 ms (default 180 ms), with 700 ms shared-event suppression. Closely spaced impacts can merge or be missed.

Clock calibration sends eight initial pings, followed by one every five seconds. Over the latest 30 round trips, the five fastest samples estimate offset as the median of `serverTime - midpoint(clientSend, clientReceive)`. The displayed uncertainty combines half-round-trip delay and offset scatter, with a 1 ms floor for timestamp quantization. This is a **network timing estimate**, not a guarantee: asymmetric networks, clock drift, event-loop delay, browser timestamps and sensor delivery latency add unmeasured error. There is no sub-millisecond accuracy claim. Relative onsets and intensity are descriptive; no triangulation, wave speed, or structural condition is inferred. Traces use a fixed ±1.5 m/s² visual scale and clip larger values; numeric event peaks remain available.

## Privacy and lifecycle

No accounts, analytics, cloud services, external fonts, storage APIs, database, or raw-data files. Signal values, names, positions, clock quality, and event summaries live only in server/browser memory. The host receives room signals and event summaries; phones receive only their own setup metadata, not other phones’ waveforms. **Anyone with the room code can join as a sensor**, so room membership is not an identity check. Use non-sensitive sensor names and a trusted private network. Room codes are convenience access, not production identity/authentication. The host's controls and each phone's reconnect capability use separate random credentials that are not included in snapshots.

The server retains at most 250 processed points per sensor (snapshots contain the latest 160), 40 event summaries, 24 sensors per room, and 50 rooms. Client batches contain at most 100 samples. Raw magnitudes are processed on arrival and not retained. On disconnect, that sensor's trace is cleared immediately; identity can reconnect for about 60 seconds, then is removed during housekeeping. Empty rooms expire after roughly 60–75 seconds. Restarting the server erases all rooms. Refreshing the browser loses its in-memory credential; keep the host tab open during a demo and create a new room after a host refresh. Network reconnection within the same page restores its role; motion must be explicitly re-enabled. No background collection.

## Validation and limits

`npm test` covers DC/slow-drift rejection, impact and refractory behavior, distinct-device windows, latency outliers, invalid data, bounded buffers, credential redaction, unauthorized control rejection, live streaming, simulated shared events, disconnect cleanup, and reconnection. `npm run build` validates JavaScript and assembles production files. Actual Chromium screenshots and interaction checks cover 1440×1000, 1024×768, 390×844 and 360×800. Native phone hardware and cross-device synchronization accuracy have not been measured. See `COMPLETION.md` for the validation summary; local screenshots are intentionally excluded from version control.

The UI is intentionally a single-room experiment. Magnitude loses direction information; rotating or handling phones can produce false triggers. Browser sample rates and device sensitivity differ. Clock-quality estimates do not remove sensor-latency uncertainty. Simulation and real devices can coexist and contribute to the same event, so stop simulation when evaluating actual phones. This server is intended for trusted LAN demos, not public hosting or adversarial clients.


## Low-latency transport and measurement

`npm run benchmark` runs the repeatable local processing budget check. `node scripts/stream-check.js` exercises 24 real loopback WebSocket clients with 4,800 samples and validates packet sizes, event delivery and bounded buffers. Neither is a phone-to-screen benchmark.

The processing benchmark warms up 300 rounds, measures 2,000 rounds (240,000 samples), and feeds 24 sensors × 5 samples per round at a synthetic 100 Hz/device cadence. Four writable mock subscribers exercise immediate event serialization and synchronous send enqueue. The test fails when **p95 exceeds 10 ms**. Workload and timestamps are deterministic; elapsed timings necessarily depend on the machine, so the broad 10 ms budget is evaluated over many rounds rather than asserting individual microsecond timings. Run `npm run benchmark` to generate measurements on your machine.

Normal sensor sends have no 100 ms batch timer or 12 ms throttle. A bounded 100-sample retry buffer is used only under backpressure, with a 10 ms retry interval. The shared-event callback dispatches synchronously during ingestion, independently of periodic snapshots. Real-signal detection retains its refractory/noise safeguards; an explicit synthetic impact resets only the virtual stimulus detector state for immediate repeated demonstrations.

Host telemetry contains only new sequenced points, on a **10 ms target** timer. Slow sockets above 64 KiB buffered output skip sends; the next writable tick reconstructs a delta from at most 250 points/device. Lost intermediate history is deliberately discarded rather than queued indefinitely. Pending event notifications are capped at 40; periodic event metadata also repairs state. A single frame may exceed the buffer threshold on initial history hydration, but message counts and payload sizes remain bounded by session limits. Phones do not receive waveform telemetry. Metadata/event reconciliation runs once per second, and full trace hydration is limited to room join/simulation reset. No redundant full-state stream runs at 100 Hz.

High-performance mode paints coalesced changes on the next animation frame. Lower-power mode targets 100 ms telemetry and idle waveform repaint; shared events still request the next frame immediately. A 60 Hz display has a **16.7 ms frame interval**. The simulation acquisition tick is 20 ms (50 Hz), while explicit impacts bypass that tick. Network/sensor scheduling, Wi-Fi, public tunnels, operating-system load and display refresh prevent a hard 10 ms end-to-end promise.

Dashboard indicators separate: (1) measured p95 server ingestion/filter/trigger/event-dispatch duration per ingestion call over the last 2,048 calls; (2) estimated host one-way network delay, half the fastest selected round trip; and (3) worst reported real-phone clock uncertainty. The 24-device benchmark measures a larger workload than one live ingestion call. Network and clock numbers do not include unmeasured sensor delivery latency. Local sub-millisecond **processing measurements** do not imply sub-millisecond clock synchronization.

## Redesign and QA

`DESIGN.md` records the local design system, typography, semantic color roles, components, responsive breakpoints, focus states and motion rules. Guided host/sensor role cards, direct mobile join links, placement/consent steps and the pre-flight checklist replace the original ambiguous entry flow. The dashboard combines paper panels with a dark scientific waveform instrument. Screenshots were captured with the Playwright skill, visually inspected, and checked for horizontal overflow. No Figma account or connector is required.

The server process must be restarted after server/library changes. Restarting erases ephemeral rooms; reload host and phone tabs and create a fresh room. The existing public tunnel configuration does not need to change if it already targets the same host port.
