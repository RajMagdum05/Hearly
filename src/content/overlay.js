// ─────────────────────────────────────────────
//  Hearly — Overlay & Voice Processing Engine
//  Runs in PAGE context (injected script tag)
// ─────────────────────────────────────────────

(function () {
  "use strict";

  const EXTENSION_ID = document.currentScript?.dataset?.extensionId;

  // ══════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════
  const State = {
    isActive: false,
    isEnrolled: false,
    voiceProfile: null,       // { mfccMeans: [], mfccStds: [] }
    audioContext: null,
    processorNode: null,
    sourceNode: null,
    originalStream: null,
    filteredStream: null,
    backgroundBuffer: [],     
    backgroundSilenceTimer: null,
    isEnrollmentInProgress: false,
    transcriptionQueue: [],
    isTranscribing: false,
    isMeetingTranscribing: false,
    activeMeetingTranscript: null, // Used for interim results
  };

  // ══════════════════════════════════════════
  //  CONSTANTS
  // ══════════════════════════════════════════
  const CHUNK_SIZE = 1024;
  const SAMPLE_RATE = 16000;
  const MATCH_THRESHOLD = 0.72;
  const SILENCE_FLUSH_MS = 1200;
  const MIN_BG_AUDIO_MS = 400;

  // ══════════════════════════════════════════
  //  UI CORE
  // ══════════════════════════════════════════

  function createOverlay() {
    if (document.getElementById("hearly-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "hearly-overlay";

    const badge = document.createElement("div");
    badge.id = "hearly-badge";
    const dot = document.createElement("span");
    dot.id = "hearly-status-dot";
    const badgeText = document.createElement("span");
    badgeText.id = "hearly-badge-text";
    badgeText.textContent = "Hearly";
    badge.append(dot, badgeText);

    const transcriptBox = document.createElement("div");
    transcriptBox.id = "hearly-transcript-box";
    const header = document.createElement("div");
    header.id = "hearly-transcript-header";
    const headerTitle = document.createElement("span");
    headerTitle.textContent = "👤 Someone nearby said:";
    const clearBtn = document.createElement("button");
    clearBtn.id = "hearly-clear-btn";
    clearBtn.textContent = "✕";
    header.append(headerTitle, clearBtn);
    
    const content = document.createElement("div");
    content.id = "hearly-transcript-content";
    transcriptBox.append(header, content);

    const toast = document.createElement("div");
    toast.id = "hearly-toast";

    const controls = document.createElement("div");
    controls.id = "hearly-controls";
    const startBtn = document.createElement("button");
    startBtn.id = "hearly-start-meeting-btn";
    startBtn.textContent = "Start Meeting Intelligence";
    controls.append(startBtn);

    overlay.append(badge, transcriptBox, toast, controls);
    document.body.appendChild(overlay);

    startBtn.addEventListener("click", () => {
      if (State.isMeetingTranscribing) {
        window.postMessage({ hearlyMsg: true, type: "HEARLY_STOP_MEETING" }, "*");
        State.isMeetingTranscribing = false;
        startBtn.textContent = "Start Meeting Intelligence";
        startBtn.classList.remove("hearly-active");
      } else {
        window.postMessage({ hearlyMsg: true, type: "HEARLY_START_MEETING" }, "*");
        State.isMeetingTranscribing = true;
        startBtn.textContent = "Stop Transcribing";
        startBtn.classList.add("hearly-active");
      }
    });

    clearBtn.addEventListener("click", () => {
      content.innerHTML = ""; // Emptying is usually fine, or use child removal
      transcriptBox.classList.remove("hearly-visible");
    });
  }

  function createEnrollmentUI() {
    if (document.getElementById("hearly-enroll-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "hearly-enroll-overlay";

    const container = document.createElement("div");
    container.className = "hearly-enroll-container";

    const title = document.createElement("h2");
    title.style.margin = "0 0 10px 0";
    title.textContent = "🎙️ Setting up Hearly";

    const steps = document.createElement("div");
    steps.className = "hearly-enroll-steps";
    for (let i = 1; i <= 3; i++) {
      const dot = document.createElement("div");
      dot.className = "hearly-step-dot";
      dot.id = `hearly-dot-${i}`;
      steps.appendChild(dot);
    }

    const message = document.createElement("div");
    message.id = "hearly-enroll-message";
    message.textContent = "Say: \"Hearly, please filter my background.\"";

    const subtext = document.createElement("div");
    subtext.id = "hearly-enroll-subtext";
    subtext.textContent = "Phrase ";
    const stepSpan = document.createElement("span");
    stepSpan.id = "hearly-current-step";
    stepSpan.textContent = "1";
    subtext.append(stepSpan, " of 3");

    const waveContainer = document.createElement("div");
    waveContainer.className = "hearly-waveform-container";
    const canvas = document.createElement("canvas");
    canvas.id = "hearly-waveform-canvas";
    waveContainer.appendChild(canvas);

    const countdown = document.createElement("div");
    countdown.id = "hearly-enroll-countdown";
    countdown.style.cssText = "font-weight: bold; color: #00e676; height: 20px;";

    container.append(title, steps, message, subtext, waveContainer, countdown);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
  }

  function updateEnrollmentUI(step, phrase) {
    const dots = document.querySelectorAll(".hearly-step-dot");
    dots.forEach((dot, i) => {
      dot.className = "hearly-step-dot" + (i < step - 1 ? " completed" : (i === step - 1 ? " active" : ""));
    });
    const msgEl = document.getElementById("hearly-enroll-message");
    const stepEl = document.getElementById("hearly-current-step");
    if (msgEl) msgEl.textContent = `Say: "${phrase}"`;
    if (stepEl) stepEl.textContent = step;
  }

  function showToast(message, type = "info") {
    const toast = document.getElementById("hearly-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `hearly-toast-${type} hearly-toast-show`;
    setTimeout(() => toast.classList.remove("hearly-toast-show"), 3000);
  }

  function updateBadge(status) {
    const dot = document.getElementById("hearly-status-dot");
    const text = document.getElementById("hearly-badge-text");
    if (!dot) return;
    dot.className = `hearly-dot-${status}`;
    const labels = {
      active: "Filtering",
      inactive: "Hearly Off",
      enrolling: "Training...",
    };
    if (text) text.textContent = labels[status] || "Hearly";
  }

  // ══════════════════════════════════════════
  //  VOICE ENGINE (Logic)
  // ══════════════════════════════════════════

  async function enrollVoice() {
    if (State.isEnrollmentInProgress) return;

    State.isEnrollmentInProgress = true;
    createEnrollmentUI();
    const overlay = document.getElementById("hearly-enroll-overlay");
    overlay.classList.add("hearly-visible");
    updateBadge("enrolling");

    const phrases = [
      "Hearly, please filter my background.",
      "My unique voice is my digital key.",
      "The meeting is now clear and quiet."
    ];

    const allFeatures = [];
    const canvas = document.getElementById("hearly-waveform-canvas");
    const ctx = canvas.getContext("2d");
    if (canvas) {
      canvas.width = canvas.clientWidth || 380;
      canvas.height = canvas.clientHeight || 60;
    }
    
    let stream, audioContext, analyser;
    try {
      stream = await originalGetMedia({ audio: true });
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let isVisualizing = true;

      const draw = () => {
        if (!isVisualizing) return;
        requestAnimationFrame(draw);
        analyser.getByteTimeDomainData(dataArray);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#00e676";
        ctx.beginPath();
        const sliceWidth = canvas.width / bufferLength;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = v * canvas.height / 2;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x += sliceWidth;
        }
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
      };
      draw();

      for (let i = 0; i < 3; i++) {
        updateEnrollmentUI(i + 1, phrases[i]);
        const samples = await capturePhraseSamples(audioContext, stream, 4000);
        allFeatures.push(...samples);
      }

      const profile = computeAggregatedProfile(allFeatures);
      if (!profile) throw new Error("Could not extract enough voice features.");
      
      State.voiceProfile = profile;
      State.isEnrolled = true;
      window.postMessage({ hearlyMsg: true, type: "HEARLY_SAVE_PROFILE", profile }, "*");
      syncProcessorState();

      const msgEl = document.getElementById("hearly-enroll-message");
      if (msgEl) msgEl.textContent = "✅ Voice Profile Registered!";
      
      setTimeout(() => {
        overlay.classList.remove("hearly-visible");
        isVisualizing = false;
        stream.getTracks().forEach(t => t.stop());
        audioContext.close();
        updateBadge(State.isActive ? "active" : "inactive");
      }, 2000);

    } catch (err) {
      console.error("Enrollment failed:", err);
      showToast("Enrollment failed: " + err.message, "error");
      overlay.classList.remove("hearly-visible");
      updateBadge(State.isActive ? "active" : "inactive");
      if (audioContext) audioContext.close();
      if (stream) stream.getTracks().forEach(t => t.stop());
    } finally {
      State.isEnrollmentInProgress = false;
    }
  }

  async function capturePhraseSamples(ctx, stream, durationMs) {
    const samples = [];
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(CHUNK_SIZE, 1, 1);
    
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      if (getRMS(data) > 0.01) {
        const mfcc = extractMFCC(data);
        if (mfcc) samples.push(mfcc);
      }
    };

    const gainNode = ctx.createGain();
    gainNode.gain.value = 0;

    source.connect(processor);
    processor.connect(gainNode);
    gainNode.connect(ctx.destination);

    const countdown = document.getElementById("hearly-enroll-countdown");
    let timeLeft = durationMs;
    while (timeLeft > 0) {
      if (countdown) countdown.textContent = `Listening... ${Math.ceil(timeLeft / 1000)}s`;
      await new Promise(r => setTimeout(r, 100));
      timeLeft -= 100;
    }

    processor.disconnect();
    source.disconnect();
    return samples;
  }

  function computeAggregatedProfile(allSamples) {
    if (!allSamples.length) return null;
    const numFeatures = allSamples[0].length;
    const means = new Float32Array(numFeatures);
    const stds = new Float32Array(numFeatures);

    for (let i = 0; i < numFeatures; i++) {
      const vals = allSamples.map(s => s[i]);
      means[i] = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + Math.pow(b - means[i], 2), 0) / vals.length;
      stds[i] = Math.sqrt(variance) || 0.001;
    }

    return { 
      mfccMeans: Array.from(means), 
      mfccStds: Array.from(stds), 
      enrolledAt: new Date().toISOString() 
    };
  }

  function extractMFCC(audioData) {
    const N = audioData.length;
    // 1. Hamming Window
    const windowed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      windowed[i] = audioData[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    // 2. FFT
    const { mag } = computeFFT(windowed);
    const spectrum = mag.slice(0, N / 2);

    // 3. Mel Filterbank (26 filters)
    const melFilters = applyMelFilterbank(spectrum, 16000, 26);
    
    // 4. Log and DCT
    const logMel = melFilters.map((v) => Math.log(v + 1e-8));
    const dct = applyDCT(logMel);
    
    return dct.slice(0, 13); // First 13 coefficients
  }

  function computeFFT(input) {
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

  function applyMelFilterbank(spectrum, sampleRate, numFilters) {
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

  function applyDCT(input) {
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

  function getRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }

  function computeVoiceSimilarity(audioChunk, profile) {
    const mfcc = extractMFCC(audioChunk);
    if (!mfcc || !profile?.mfccMeans || !profile?.mfccStds) return 0;
    const means = profile.mfccMeans;
    const stds = profile.mfccStds;
    let sumSquaredZ = 0;
    for (let i = 0; i < mfcc.length; i++) {
        const z = (mfcc[i] - (means[i] || 0)) / (stds[i] || 0.001);
        sumSquaredZ += z * z;
    }
    const distance = Math.sqrt(sumSquaredZ);
    return Math.max(0, 1 - (distance / 4.0));
  }

  // ══════════════════════════════════════════
  //  AUDIO PIPELINE
  // ══════════════════════════════════════════

  const originalGetMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await originalGetMedia(constraints);
    if (!hasAudioTrackRequest(constraints)) return stream;
    return processStream(stream);
  };

  async function processStream(rawStream) {
    State.originalStream = rawStream;
    State.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    
    // Attempt worklet load
    const workletUrl = EXTENSION_ID ? `chrome-extension://${EXTENSION_ID}/src/worklet/voice-processor.js` : null;
    try {
      if (workletUrl) await State.audioContext.audioWorklet.addModule(workletUrl);
    } catch(e) { console.warn("Worklet failed, fallback used", e); }

    State.sourceNode = State.audioContext.createMediaStreamSource(rawStream);
    const destination = State.audioContext.createMediaStreamDestination();
    await setupVoiceFilter(State.sourceNode, destination);
    
    State.filteredStream = destination.stream;
    rawStream.getVideoTracks().forEach(t => State.filteredStream.addTrack(t));
    bindPipelineCleanup(rawStream, State.audioContext);
    syncProcessorState();
    return State.filteredStream;
  }

  async function setupVoiceFilter(source, destination) {
    try {
      const node = new AudioWorkletNode(State.audioContext, 'hearly-voice-processor');
      node.port.postMessage({ type: 'SET_ACTIVE', data: State.isActive });
      if (State.voiceProfile) node.port.postMessage({ type: 'SET_PROFILE', data: State.voiceProfile });
      
      node.port.onmessage = (e) => {
        if (e.data.type === 'BACKGROUND_AUDIO') processBackgroundAudio(new Float32Array(e.data.samples));
      };

      source.connect(node);
      node.connect(destination);
      State.processorNode = node;
      syncProcessorState();
      return;
    } catch(e) {}

    const processor = State.audioContext.createScriptProcessor(CHUNK_SIZE, 1, 1);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const output = e.outputBuffer.getChannelData(0);
      if (!State.isActive || !State.isEnrolled || !State.voiceProfile) {
        output.set(input);
        return;
      }
      const sim = computeVoiceSimilarity(input, State.voiceProfile);
      if (sim >= MATCH_THRESHOLD || getRMS(input) < 0.01) {
        output.set(input);
      } else {
        output.fill(0);
        State.backgroundBuffer.push(new Float32Array(input));
        scheduleFlush();
      }
    };
    source.connect(processor);
    processor.connect(destination);
    State.processorNode = processor;
    syncProcessorState();
  }

  // ══════════════════════════════════════════
  //  STretching Transcription
  // ══════════════════════════════════════════

  function scheduleFlush() {
    clearTimeout(State.backgroundSilenceTimer);
    State.backgroundSilenceTimer = setTimeout(flushBackgroundBuffer, SILENCE_FLUSH_MS);
  }

  function flushBackgroundBuffer() {
    if (!State.backgroundBuffer.length) return;
    const total = State.backgroundBuffer.reduce((s, c) => s + c.length, 0);
    if (total < SAMPLE_RATE * (MIN_BG_AUDIO_MS/1000)) {
        State.backgroundBuffer = [];
        return;
    }
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of State.backgroundBuffer) { merged.set(c, offset); offset += c.length; }
    State.backgroundBuffer = [];
    processBackgroundAudio(merged);
  }

  function processBackgroundAudio(samples) {
    const wav = floatArrayToWav(samples, SAMPLE_RATE);
    const base64 = arrayBufferToBase64(wav);
    State.transcriptionQueue.push(base64);
    drainTranscriptionQueue();
  }

  function floatArrayToWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const writeS = (o, s) => { for (let i=0; i<s.length; i++) view.setUint8(o+i, s.charCodeAt(i)); };
    writeS(0, "RIFF"); view.setUint32(4, 36 + samples.length*2, true); writeS(8, "WAVE");
    writeS(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate*2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeS(36, "data"); view.setUint32(40, samples.length*2, true);
    for (let i=0; i<samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i*2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  function arrayBufferToBase64(buffer) {
    const b = new Uint8Array(buffer);
    let s = "";
    for (let i=0; i<b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }

  function escapeHtml(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }

  function showTranscript(text, source = "background", isFinal = true, speaker = 0) {
    const box = document.getElementById("hearly-transcript-box");
    const content = document.getElementById("hearly-transcript-content");
    const headerTitle = document.querySelector("#hearly-transcript-header span");
    if (!box || !content) return;
    
    // Update header based on source
    if (headerTitle) {
      headerTitle.textContent = source === "meeting" ? "🎙️ Meeting Transcript" : "👤 Someone nearby said:";
    }

    if (source === "meeting" && !isFinal) {
      // Handle interim results for meeting transcription
      if (!State.activeMeetingTranscript) {
        State.activeMeetingTranscript = document.createElement("div");
        State.activeMeetingTranscript.className = "hearly-entry hearly-interim";
        content.appendChild(State.activeMeetingTranscript);
      }
      State.activeMeetingTranscript.textContent = `[Speaker ${speaker}]: ${text}`;
      content.scrollTop = content.scrollHeight;
      box.classList.add("hearly-visible");
      return;
    }

    if (source === "meeting" && isFinal) {
      if (State.activeMeetingTranscript) {
        State.activeMeetingTranscript.classList.remove("hearly-interim");
        State.activeMeetingTranscript.textContent = `[Speaker ${speaker}]: ${text}`;
        State.activeMeetingTranscript = null;
      } else {
        const entry = document.createElement("div");
        entry.className = "hearly-entry";
        entry.textContent = `[Speaker ${speaker}]: ${text}`;
        content.appendChild(entry);
      }
    } else {
      // Background source
      const entry = document.createElement("div");
      entry.className = "hearly-entry hearly-background-alert";
      
      const entryText = document.createElement("span");
      entryText.className = "hearly-entry-text";
      entryText.textContent = text;
      
      entry.appendChild(entryText);
      content.appendChild(entry);
    }

    content.scrollTop = content.scrollHeight;
    box.classList.add("hearly-visible");
    
    // Auto-hide after 8 seconds if it's a background alert
    if (source === "background") {
      clearTimeout(State._hideT);
      State._hideT = setTimeout(() => {
        if (!State.isMeetingTranscribing) box.classList.remove("hearly-visible");
      }, 8000);
    }
  }

  async function drainTranscriptionQueue() {
    if (State.isTranscribing || State.transcriptionQueue.length === 0) return;

    State.isTranscribing = true;
    const audioBase64 = State.transcriptionQueue.shift();
    window.postMessage({ hearlyMsg: true, type: "HEARLY_TRANSCRIBE", audioBase64 }, "*");
  }

  function handleTranscriptResult(text) {
    State.isTranscribing = false;

    const normalized = typeof text === "string" ? text.trim() : "";
    if (!normalized) {
      drainTranscriptionQueue();
      return;
    }

    if (normalized.startsWith("⚠️") || normalized.startsWith("❌")) {
      showToast(normalized, "error");
      drainTranscriptionQueue();
      return;
    }

    showTranscript(normalized);
    drainTranscriptionQueue();
  }

  function syncProcessorState() {
    if (!State.processorNode?.port) return;

    State.processorNode.port.postMessage({ type: "SET_ACTIVE", data: State.isActive });
    if (State.voiceProfile) {
      State.processorNode.port.postMessage({ type: "SET_PROFILE", data: State.voiceProfile });
    }
  }

  function hasAudioTrackRequest(constraints) {
    if (constraints === true) return true;
    if (!constraints || typeof constraints !== "object") return false;
    return Boolean(constraints.audio);
  }

  function bindPipelineCleanup(rawStream, audioContext) {
    const cleanup = () => {
      if (State.audioContext === audioContext) {
        State.processorNode = null;
        State.sourceNode = null;
        State.originalStream = null;
        State.filteredStream = null;
        State.audioContext = null;
      }

      audioContext.close().catch(() => {});
    };

    rawStream.getTracks().forEach((track) => {
      track.addEventListener("ended", cleanup, { once: true });
    });
  }

  // ══════════════════════════════════════════
  //  INIT & EVENTS
  // ══════════════════════════════════════════

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data?.hearlyMsg) return;
    const msg = e.data;
    if (msg.type === "HEARLY_STORAGE_DATA") {
        State.isActive = msg.data.hearlyActive;
        State.isEnrolled = msg.data.hearlyEnrolled;
        State.voiceProfile = msg.data.voiceProfile;
        syncProcessorState();
        updateBadge(State.isActive ? "active" : "inactive");
    } else if (msg.type === "HEARLY_TOGGLE") {
        State.isActive = msg.value;
        if (!State.isActive) {
          State.backgroundBuffer = [];
          State.transcriptionQueue = [];
          State.isTranscribing = false;
          clearTimeout(State.backgroundSilenceTimer);
        }
        syncProcessorState();
        updateBadge(State.isActive ? "active" : "inactive");
    } else if (msg.type === "HEARLY_TRANSCRIPT_RESULT") {
        handleTranscriptResult(msg.text);
    } else if (msg.type === "HEARLY_PROFILE_UPDATED") {
        State.voiceProfile = msg.profile;
        State.isEnrolled = true;
        syncProcessorState();
        showToast("Voice profile updated", "success");
    } else if (msg.type === "HEARLY_ENROLL") {
        enrollVoice();
    } else if (msg.type === "HEARLY_MEETING_TRANSCRIPT") {
        showTranscript(msg.text, "meeting", msg.isFinal, msg.speaker);
    }
  });

  function init() {
    createOverlay();
    window.postMessage({ hearlyMsg: true, type: "HEARLY_GET_STORAGE" }, "*");
    console.log("[Hearly] Unified Engine Initialized");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.__hearlyEnroll = enrollVoice;

})();
