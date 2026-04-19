// ─────────────────────────────────────────────
//  Hearly — Overlay & Voice Processing Engine
//  Runs in PAGE context (injected script tag)
// ─────────────────────────────────────────────

(function () {
  "use strict";

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
    requestIdCounter: 0,
    deepgramApiKey: null,
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

    overlay.append(badge, transcriptBox, toast);
    document.body.appendChild(overlay);

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
    
    let stream, audioContext, analyser;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

      const msgEl = document.getElementById("hearly-enroll-message");
      if (msgEl) msgEl.textContent = "✅ Voice Profile Registered!";
      
      setTimeout(() => {
        overlay.classList.remove("hearly-visible");
        isVisualizing = false;
        stream.getTracks().forEach(t => t.stop());
        audioContext.close();
        updateBadge("inactive");
      }, 2000);

    } catch (err) {
      console.error("Enrollment failed:", err);
      showToast("Enrollment failed: " + err.message, "error");
      overlay.classList.remove("hearly-visible");
      updateBadge("inactive");
      if (audioContext) audioContext.close();
      if (stream) stream.getTracks().forEach(t => t.stop());
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

    source.connect(processor);
    processor.connect(ctx.destination);

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
    const spectrum = computeFFTMagnitude(audioData);
    const melFilters = applyMelFilterbank(spectrum, SAMPLE_RATE, 26);
    const logMel = melFilters.map((v) => Math.log(v + 1e-8));
    const mfcc = applyDCT(logMel);
    return mfcc.slice(0, 13); 
  }

  function computeFFTMagnitude(signal) {
    const N = signal.length;
    const magnitude = new Float32Array(N / 2);
    // Magnitude approximation
    for (let k = 0; k < N / 2; k++) {
      let real = 0, imag = 0;
      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N;
        real += signal[n] * Math.cos(angle);
        imag -= signal[n] * Math.sin(angle);
      }
      magnitude[k] = Math.sqrt(real * real + imag * imag);
    }
    return magnitude;
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
    if (!constraints?.audio || !State.isActive || !State.isEnrolled) return stream;
    return processStream(stream);
  };

  async function processStream(rawStream) {
    State.originalStream = rawStream;
    State.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    
    // Attempt worklet load
    const extId = document.currentScript?.dataset?.extensionId;
    const workletUrl = extId ? `chrome-extension://${extId}/src/worklet/voice-processor.js` : null;
    try {
      if (workletUrl) await State.audioContext.audioWorklet.addModule(workletUrl);
    } catch(e) { console.warn("Worklet failed, fallback used"); }

    State.sourceNode = State.audioContext.createMediaStreamSource(rawStream);
    const destination = State.audioContext.createMediaStreamDestination();
    await setupVoiceFilter(State.sourceNode, destination);
    
    State.filteredStream = destination.stream;
    rawStream.getVideoTracks().forEach(t => State.filteredStream.addTrack(t));
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
    window.postMessage({ hearlyMsg: true, type: "HEARLY_TRANSCRIBE", audioBase64: base64 }, "*");
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

  function showTranscript(text) {
    const box = document.getElementById("hearly-transcript-box");
    const content = document.getElementById("hearly-transcript-content");
    if (!box || !content) return;
    
    const entry = document.createElement("div");
    entry.className = "hearly-entry";
    
    const entryText = document.createElement("span");
    entryText.className = "hearly-entry-text";
    entryText.textContent = text;
    
    entry.appendChild(entryText);
    content.appendChild(entry);
    content.scrollTop = content.scrollHeight;
    box.classList.add("hearly-visible");
    clearTimeout(State._hideT);
    State._hideT = setTimeout(() => box.classList.remove("hearly-visible"), 8000);
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
        updateBadge(State.isActive ? "active" : "inactive");
    } else if (msg.type === "HEARLY_TOGGLE") {
        State.isActive = msg.value;
        updateBadge(State.isActive ? "active" : "inactive");
    } else if (msg.type === "HEARLY_TRANSCRIPT_RESULT") {
        showTranscript(msg.text);
    } else if (msg.type === "HEARLY_ENROLL") {
        enrollVoice();
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
