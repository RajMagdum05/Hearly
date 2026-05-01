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
          if (!data) {
            this.bgBuffer = [];
            this.bgSampleCount = 0;
            this.silenceFrames = 0;
          }
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

    if (!input || !input[0] || !output || !output[0]) return true;

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

    // Accumulate samples into ring buffer
    if (!this._ringBuffer) {
      this._ringBuffer = new Float32Array(1024);
      this._rbIndex = 0;
    }
    
    // Add new samples
    for (let i = 0; i < audioChunk.length; i++) {
       this._ringBuffer[this._rbIndex] = audioChunk[i];
       this._rbIndex = (this._rbIndex + 1) % 1024;
    }

    // Only process MFCC every few chunks to save CPU
    this._chunksSinceLastMFCC = (this._chunksSinceLastMFCC || 0) + 1;
    if (this._chunksSinceLastMFCC < 4) return this._lastSim || 0; // Approx every 32ms
    this._chunksSinceLastMFCC = 0;

    // Get ordered frame from ring buffer
    const frame = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      frame[i] = this._ringBuffer[(this._rbIndex + i) % 1024];
    }

    const features = this.extractMFCC(frame);
    const means = this.voiceProfile.mfccMeans;
    const stds = this.voiceProfile.mfccStds;

    let distanceSum = 0;
    const len = Math.min(features.length, means.length);

    for (let i = 0; i < len; i++) {
      const std = stds[i] > 0.001 ? stds[i] : 0.001;
      const diff = (features[i] - means[i]) / std;
      distanceSum += diff * diff;
    }

    const distance = Math.sqrt(distanceSum / len);
    this._lastSim = Math.max(0, 1 - (distance / 4.0));
    return this._lastSim;
  }

  extractMFCC(audioData) {
    const N = audioData.length;
    // 1. Hamming Window
    const windowed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      windowed[i] = audioData[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    // 2. FFT
    const { mag } = this.fft(windowed);
    const spectrum = mag.slice(0, N / 2);

    // 3. Mel Filterbank (26 filters)
    const melFilters = this.applyMelFilterbank(spectrum, 16000, 26);
    
    // 4. Log and DCT
    const logMel = melFilters.map((v) => Math.log(v + 1e-8));
    const dct = this.applyDCT(logMel);
    
    return dct.slice(0, 13); // First 13 coefficients
  }

  fft(input) {
    const n = input.length;
    const real = new Float32Array(input);
    const imag = new Float32Array(n);

    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }

    // Cooley-Tukey iterative Radix-2 FFT
    for (let len = 2; len <= n; len <<= 1) {
        const ang = 2 * Math.PI / len;
        const wlen_real = Math.cos(ang);
        const wlen_imag = -Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let w_real = 1;
            let w_imag = 0;
            for (let j = 0; j < len / 2; j++) {
                const u_real = real[i + j];
                const u_imag = imag[i + j];
                const v_real = real[i + j + len / 2] * w_real - imag[i + j + len / 2] * w_imag;
                const v_imag = real[i + j + len / 2] * w_imag + imag[i + j + len / 2] * w_real;
                real[i + j] = u_real + v_real;
                imag[i + j] = u_imag + v_imag;
                real[i + j + len / 2] = u_real - v_real;
                imag[i + j + len / 2] = u_imag - v_imag;
                const tmp_real = w_real * wlen_real - w_imag * wlen_imag;
                w_imag = w_real * wlen_imag + w_imag * wlen_real;
                w_real = tmp_real;
            }
        }
    }

    const mag = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }
    return { real, imag, mag };
  }

  applyMelFilterbank(spectrum, sampleRate, numFilters) {
    const melMin = 2595 * Math.log10(1 + 300 / 700);
    const melMax = 2595 * Math.log10(1 + (sampleRate / 2) / 700);
    const melPoints = Array.from({ length: numFilters + 2 }, (_, i) => {
        const mel = melMin + (i * (melMax - melMin)) / (numFilters + 1);
        return 700 * (Math.pow(10, mel / 2595) - 1);
    });

    const fftBins = spectrum.length;
    const filters = new Float32Array(numFilters);
    for (let m = 1; m <= numFilters; m++) {
      let energy = 0;
      for (let k = 0; k < fftBins; k++) {
        const freq = (k * sampleRate) / (2 * fftBins);
        if (freq >= melPoints[m-1] && freq <= melPoints[m]) {
          energy += spectrum[k] * ((freq - melPoints[m-1]) / (melPoints[m] - melPoints[m-1]));
        } else if (freq > melPoints[m] && freq <= melPoints[m+1]) {
          energy += spectrum[k] * ((melPoints[m+1] - freq) / (melPoints[m+1] - melPoints[m]));
        }
      }
      filters[m-1] = energy;
    }
    return filters;
  }

  applyDCT(input) {
    const N = input.length;
    const output = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      let sum = 0;
      for (let n = 0; n < N; n++) {
        sum += input[n] * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * N));
      }
      output[k] = sum;
    }
    return output;
  }

  getRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }
}

registerProcessor("hearly-voice-processor", HearlyVoiceProcessor);
