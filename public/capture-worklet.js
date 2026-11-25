// AudioWorkletProcessor capturing mono microphone chunks tagged with the
// AudioContext render clock (`currentFrame`) so intervals remain truthful even
// across audio buffer discontinuities.
// Capture chunking and discontinuity handling inspired by beep-locator (Apache-2.0).

class RqCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 2048;
    this.buf = new Float32Array(this.chunkSize + 256);
    this.n = 0;
    this.startFrame = null;
    this.lastFrame = null;
    this.lastLen = 128;
    this.active = true;

    this.port.onmessage = (event) => {
      if (event?.data?.type === "stop") {
        this.flush();
        this.active = false;
      }
    };
  }

  flush() {
    if (this.n === 0) return;
    const out = this.buf.slice(0, this.n);
    this.port.postMessage(
      { frame: this.startFrame, samples: out },
      [out.buffer],
    );
    this.startFrame += this.n;
    this.n = 0;
  }

  process(inputs) {
    if (!this.active) return false;

    const input = inputs[0];
    const ch = input && input.length > 0 ? input[0] : null;
    const len = ch ? ch.length : 128;
    // eslint-disable-next-line no-undef
    const frame = currentFrame;

    if (this.startFrame === null) {
      this.startFrame = frame;
    }

    // Clock discontinuity: flush buffered audio before resetting startFrame so
    // timestamps never drift across render gaps or dropped frames.
    if (this.lastFrame !== null && frame !== this.lastFrame + this.lastLen) {
      this.flush();
      this.startFrame = frame;
    }

    if (this.n + len > this.buf.length) {
      this.flush();
      if (len > this.buf.length) {
        this.buf = new Float32Array(Math.max(this.chunkSize + 256, len));
      }
    }

    if (ch) {
      this.buf.set(ch, this.n);
    } else {
      this.buf.fill(0, this.n, this.n + len);
    }

    this.n += len;
    this.lastFrame = frame;
    this.lastLen = len;

    if (this.n >= this.chunkSize) {
      this.flush();
    }
    return true;
  }
}

registerProcessor("rq-capture", RqCaptureProcessor);
