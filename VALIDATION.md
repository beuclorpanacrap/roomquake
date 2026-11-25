# RoomQuake — Rehearsal & Hardware Validation Guide

> **Hardware validation status:** **PENDING** (no physical phones or tabletop were attached in the development/agent environment). Software, unit/integration tests, production build, local pipeline benchmark, and 24-client loopback stream checks were verified locally; physical phone trials below must be executed and recorded on real hardware before live judging.

---

## 1. Launch & Trusted HTTPS Setup

Mobile browsers (`iOS Safari` and `Android Chrome`) require a **secure context** (`https://`) to grant `DeviceMotionEvent` and `getUserMedia` access on a LAN IP. Desktop `localhost` does not work for phones.

### Primary Setup: Trusted Local LAN HTTPS (`mkcert`) — Lowest Latency
1. Connect the host laptop and up to 4 phones to the **same private trusted Wi-Fi** (client isolation disabled; allow inbound TCP port `3000` on the private firewall).
2. Find the laptop's LAN IP (e.g., `192.168.1.25` via `ipconfig` on Windows or `ipconfig getifaddr en0` on macOS).
3. Install `mkcert` from its official release and create a local CA + server certificate:
   ```sh
   mkcert -install
   mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 192.168.1.25
   ```
4. Trust **only the public root certificate** (`rootCA.pem` from `mkcert -CAROOT`) on each phone:
   - **iOS:** AirDrop/open `rootCA.pem` → install profile in *Settings* → *General* → *VPN & Device Management* → enable full trust under *Settings → General → About → Certificate Trust Settings*.
   - **Android:** Copy `rootCA.pem` → *Settings → Security → Encryption & credentials → Install a certificate → CA certificate*.
   - **Never copy `rootCA-key.pem` or `localhost-key.pem` to any phone.** Remove the dev CA after the hackathon.
5. Start the production-built or root RoomQuake server over HTTPS:
   ```sh
   cd roomquake
   npm ci
   npm run build
   # PowerShell:
   $env:TLS_CERT="localhost.pem"; $env:TLS_KEY="localhost-key.pem"; node dist/server.js
   # bash/zsh:
   TLS_CERT=localhost.pem TLS_KEY=localhost-key.pem node dist/server.js
   ```
6. Open **`https://192.168.1.25:3000`** on the host laptop (NOT `localhost`, so the QR code encodes the reachable LAN HTTPS address!).

### Fallback Setup: `cloudflared` Public Tunnel
If the venue Wi-Fi blocks peer-to-peer LAN traffic or you cannot install a local CA on judge phones:
1. Run RoomQuake locally on HTTP (`npm start`, port `3000`).
2. Start a quick Cloudflare tunnel:
   ```sh
   cloudflared tunnel --url http://localhost:3000
   ```
3. Open the printed `https://<random>.trycloudflare.com` URL on the host laptop, create a room, and let phones scan the QR code.
4. **Expected difference:** Public tunnel traffic routes off-LAN, increasing WebSocket RTT and `syncQuality` uncertainty compared to local `mkcert` LAN HTTPS. Always prefer `mkcert` LAN HTTPS when possible.

### Dry-Run Fallback (No Physical Phones)
1. Open `http://localhost:3000` → **Create a room**.
2. Open **Projector Stage** (or stay in **Lab View**) and click **Start simulation**.
3. Notice that by default simulated hits remain **silent** (`SIMULATION (LIVE AUDIO MUTED)`) so simulated events never fire accidentally during live performance. To rehearse sound/Play Assist without phones, explicitly check **Audition simulation audio** in the instrument toolbar and click **Send an impact** (or switch back off before plugging in real phones).

---

## 2. Rehearsal Procedure (Laptop + 4 Phones on One Rigid Table)

1. **Host setup:** Open `https://<LAN-IP>:3000` on laptop → **Create a room** → click **Enable Audio** (verify `AUDIO READY`) → click **Projector Stage ↗** (automatically selects **Performance · Rhythm 140 ms** profile and shows large lobby QR).
2. **Phone onboarding (no manual grid):**
   - Scan projector QR on Phone 1–4.
   - Tap **Join & Enable Motion →** (grants iOS motion permission directly inside the tap, joins placement-free, waits for room join + clock sync).
   - Lay each phone flat on the rigid tabletop (~20–40 cm apart). Confirm status transitions: `PLACE FLAT` → `CALIBRATING` (~1 s) → `READY`.
   - Projector automatically hides the lobby QR once ≥ 2 phones are ready (keep corner **QR Join** button available).
3. **Milestone 1 Sanity Check (Free Play):**
   - Pick up and tap Phone 1 gently in the air (or bump only Phone 1 lightly without shaking the table): Phone 1's trace twitches amber (`LOCAL BUMP`), **room stays silent**, no ripple fires.
   - Knock firmly once on the shared tabletop: confirming sensors light up, **exactly one** warm chord plays, and **one** luminous ripple expands and decays across the projector stage.
4. **Play Assist Showcase (*Ashen Cathedral*):**
   - Switch Instrument Mode to **Play Assist · Orchestral Cue**.
   - Tap steadily (~1 beat/sec, pausing dramatically at section transitions) through the 28 steps (`I. Ember` → `II. Procession` → `III. Choir of Cinders` → `IV. Bell & Brass Climax` → `V. Requiem`).
   - Optionally import a local `.mid` file (`Import MIDI`) and choose a track to verify MIDI chord stepping.
5. **P3 Optional Acoustic Ranging Experiment (Separate Check):**
   - On each phone, expand *Optional experiment: Microphone & acoustic ranging* → tap **Enable optional microphone** (test declining mic on one phone first to verify motion sensing still works).
   - In Lab View → *Acoustic layout experiment* → click **Run chirp calibration**. Only accept measured layout if residual error ≤ 15 cm and tape-measured spacing matches after moving a phone.

---

## 3. Hardware Measurement Protocol & Trial Sheet

> **Important measurement separation:** Always report **(a) Server processing p95**, **(b) Network ½ RTT & clock uncertainty**, and **(c) Physical tap-to-sound latency** separately. Server processing p95 does *not* measure end-to-end physical latency. Measure physical tap-to-sound externally by placing a fifth recorder (e.g., laptop mic / voice memo) recording both the wooden tabletop knock transient and the laptop speaker synth onset, and reading the waveform delta in Audacity/Python.

### Device Inventory (Fill During Hardware Test)
| Slot | Phone Model | OS Version | Browser & Version | Transport Mode (`mkcert` / tunnel) |
|---|---|---|---|---|
| Phone 1 | *PENDING* | *PENDING* | *PENDING* | *PENDING* |
| Phone 2 | *PENDING* | *PENDING* | *PENDING* | *PENDING* |
| Phone 3 | *PENDING* | *PENDING* | *PENDING* | *PENDING* |
| Phone 4 | *PENDING* | *PENDING* | *PENDING* | *PENDING* |

### Trial Results Sheet
| Trial | Target / Acceptance Goal | Measured Result | Status |
|---|---|---|---|
| **Baseline Server Processing p95** (`npm run benchmark`) | `< 10 ms` budget (`< 1.0 ms` target) | `< 0.2 ms` (reproduce via `npm run benchmark`, 240k samples) | **PASS (Software)** |
| **Loopback 24-client Stream Check** (`node scripts/stream-check.js`) | 0 errors, bounded payloads `< 64 KiB` | `0` errors, `< 16 KiB` max payload, 4,800 samples | **PASS (Loopback)** |
| **QR → Ready Onboarding Time** (per phone) | `≤ 15 s` | *PENDING* | **PENDING (Hardware)** |
| **Inter-Device Clock Uncertainty** (`syncQuality` on LAN) | `≤ ±20 ms` | *PENDING* | **PENDING (Hardware)** |
| **External Physical Tap-to-Sound Latency** (20 knocks, audio recording delta) | Median `≤ 90 ms`, p95 `≤ 140 ms` | *PENDING* | **PENDING (Hardware)** |
| **120 BPM Steady Taps** (30 taps, 2 players, Performance profile) | Recall `≥ 95%`, double-triggers `≤ 1` | *PENDING* | **PENDING (Hardware)** |
| **180 BPM Fast Taps** (30 taps, Performance profile) | Recall `≥ 90%`, double-triggers `≤ 2` | *PENDING* | **PENDING (Hardware)** |
| **Ringing / Decay Rejection** (15 firm knocks on resonant wood table) | `0` spurious post-knock triggers | *PENDING* | **PENDING (Hardware)** |
| **Isolated Single-Phone Bumps** (10 flat bumps + 10 pickup/set-down) | `0 / 20` audio/Assist triggers | *PENDING* | **PENDING (Hardware)** |
| **Acoustic Interference Negatives** (15 airborne claps, 30 s speech, 30 s speaker playback) | `0` false audio/Assist triggers | *PENDING* | **PENDING (Hardware)** |
| **Background / Disconnect / Reconnect** (hide tab + toggle Wi-Fi) | Zero replayed chords; explicit re-enable required | *PENDING* | **PENDING (Hardware)** |
| **P3 Stretch: Acoustic Ranging vs Tape Measure** (4 phones, 2 rounds, + move 1 phone) | Pairwise error `≤ 15 cm` repeatable | *PENDING* | **PENDING (Hardware)** |
| **P3 Stretch: Live Audio Fusion vs Motion-Only A/B** | Only enable if recall improves with `0` speaker/clap FPs | *PENDING* | **PENDING (Hardware)** |
