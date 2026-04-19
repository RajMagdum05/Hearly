// ─────────────────────────────────────────────
//  Hearly — AudioWorklet Voice Processor
//  Runs on dedicated audio thread (not main thread)
//  Zero UI blocking, ultra low latency ~3–10ms
// ─────────────────────────────────────────────

class HearlyVoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.isActive = false;
    this.isEnrolled = false;
    this.voiceProfile = null;
    this.matchThreshold = 0.72;

    // Background audio accumulation
    this.bgBuffer = [];
    this.bgSampleCount = 0;
    this.silenceFrames = 0;
    this.SILENCE_FLUSH_FRAMES = 800; // ~800 * 128 samples / 16000hz ≈ 6.4s max

    // Listen for commands from main thread
    this.port.onmessage = (event) => {
      const { type, data } = event.data;
      switch (type) {
        case "SET_ACTIVE":
          this.isActive = data;
          break;
        case "SET_PROFILE":
          this.voiceProfile = data;
          this.isEnrolled = true;
          break;
        case "SET_THRESHOLD":
          this.matchThreshold = data;
          break;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) return true;

    const inputChannel = input[0];
    const outputChannel = output[0];

    if (!this.isActive || !this.isEnrolled || !this.voiceProfile) {
      // Pass through unchanged
      outputChannel.set(inputChannel);
      return true;
    }

    const rms = this.getRMS(inputChannel);
    const hasVoice = rms > 0.01;

    if (!hasVoice) {
      // Silence — pass through, flush if bg buffer has content
      outputChannel.set(inputChannel);
      this.silenceFrames++;
      if (this.silenceFrames > 30 && this.bgBuffer.length > 0) {
        this.flushBgBuffer();
      }
      return true;
    }

    this.silenceFrames = 0;
    const similarity = this.computeSimilarity(inputChannel);
    const isUser = similarity >= this.matchThreshold;

    if (isUser) {
      // ✅ User's voice — pass to meeting
      outputChannel.set(inputChannel);
      // Flush any accumulated background audio
      if (this.bgBuffer.length > 0) this.flushBgBuffer();
    } else {
      // ❌ Background voice — MUTE from meeting output
      outputChannel.fill(0);
      // Accumulate for STT
      this.bgBuffer.push(new Float32Array(inputChannel));
      this.bgSampleCount += inputChannel.length;

      // Safety flush if buffer too large
      if (this.bgSampleCount > 16000 * 8) { // 8 second max
        this.flushBgBuffer();
      }
    }

    return true;
  }

  flushBgBuffer() {
    if (this.bgBuffer.length === 0) return;

    const totalSamples = this.bgSampleCount;
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this.bgBuffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    this.bgBuffer = [];
    this.bgSampleCount = 0;

    // Send to main thread for STT processing
    this.port.postMessage({
      type: "BACKGROUND_AUDIO",
      samples: merged.buffer,
      sampleCount: totalSamples,
    }, [merged.buffer]); // Transfer ownership for zero-copy
  }

  computeSimilarity(audioChunk) {
    if (!this.voiceProfile?.mfccMeans) return 0;

    const features = this.extractFeatures(audioChunk);
    const means = this.voiceProfile.mfccMeans;
    const stds = this.voiceProfile.mfccStds;

    if (!features || features.length !== means.length) return 0;

    let distanceSum = 0;
    const len = Math.min(features.length, means.length);

    for (let i = 0; i < len; i++) {
      const std = stds[i] > 0 ? stds[i] : 1;
      const diff = (features[i] - means[i]) / std;
      distanceSum += diff * diff;
    }

    const distance = Math.sqrt(distanceSum / len);
    return Math.max(0, 1 - (distance / 4.0));
  }

  extractFeatures(audioData) {
    // Basic MFCC-like extraction for real-time consistency
    // Apply Hamming window
    const N = audioData.length;
    const windowed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      windowed[i] = audioData[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    // Simplified spectral analysis (ZCR + Multiple Bands)
    const features = new Float32Array(13);
    
    // Feature 0: ZCR
    let zcr = 0;
    for (let i = 1; i < N; i++) if ((windowed[i] >= 0) !== (windowed[i-1] >= 0)) zcr++;
    features[0] = zcr / N;

    // Features 1-12: Band Energy (Log scale approximation)
    const numBands = 12;
    const bandWidth = Math.floor(N / (numBands * 2)); // Focus on speech range
    for (let b = 0; b < numBands; b++) {
      let energy = 0;
      const start = b * bandWidth;
      for (let i = start; i < start + bandWidth; i++) energy += windowed[i] * windowed[i];
      features[b + 1] = Math.log10(Math.sqrt(energy / bandWidth) + 1e-6);
    }

    return features;
  }

  getRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }
}

registerProcessor("hearly-voice-processor", HearlyVoiceProcessor);
