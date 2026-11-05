// Turns microphone audio into 100 ms frames of 16 kHz mono int16 PCM - the
// format whisperflow expects. The AudioContext is created at 16 kHz, so the
// browser has already resampled; this only converts and batches.
class PcmFrames extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Int16Array(1600)
    this.n = 0
    this.peak = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]))
      this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff
      const a = Math.abs(v)
      if (a > this.peak) this.peak = a
      if (this.n === this.frame.length) {
        this.port.postMessage({ pcm: this.frame.buffer, level: this.peak }, [this.frame.buffer])
        this.frame = new Int16Array(1600)
        this.n = 0
        this.peak = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-frames', PcmFrames)
