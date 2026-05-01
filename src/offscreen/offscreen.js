// ─────────────────────────────────────────────
//  Hearly — Offscreen Audio Processor (LOCAL)
//  Handles tabCapture and Local Whisper Transcription
// ─────────────────────────────────────────────

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers';

// Configuration for local environment
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let audioContext = null;
let processor = null;
let source = null;
let audioBuffer = []; // Accumulate samples for inference
const CHUNK_THRESHOLD = 16000 * 4; // Process every 4 seconds of audio

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== "offscreen") return;

  if (message.type === "START_TAB_RECORDING") {
    startLocalCapture(message.data.streamId);
  } else if (message.type === "STOP_TAB_RECORDING") {
    stopLocalCapture();
  }
});

async function ensureTranscriber() {
  if (transcriber) return;
  console.log("[Hearly-Offscreen] Loading Local Whisper Model (Xenova/whisper-tiny.en)...");
  try {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: (p) => {
        if (p.status === 'progress') {
            console.log(`[Hearly-Offscreen] Model Loading: ${p.progress.toFixed(2)}%`);
        }
      }
    });
    console.log("[Hearly-Offscreen] Local Whisper Model Loaded.");
  } catch (err) {
    console.error("[Hearly-Offscreen] Failed to load model:", err);
  }
}

async function startLocalCapture(streamId) {
  await ensureTranscriber();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    source = audioContext.createMediaStreamSource(stream);
    
    // ── Keep audio audible ────────────────────────
    source.connect(audioContext.destination);

    // ── Inference Processor ───────────────────────
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      audioBuffer.push(...input);

      if (audioBuffer.length >= CHUNK_THRESHOLD) {
        const toProcess = new Float32Array(audioBuffer);
        audioBuffer = []; // Clear for next window
        runInference(toProcess);
      }
    };

    console.log("[Hearly-Offscreen] Local capture started.");
  } catch (err) {
    console.error("[Hearly-Offscreen] Capture failed:", err);
  }
}

async function runInference(samples) {
  if (!transcriber) return;

  try {
    const start = performance.now();
    const result = await transcriber(samples, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: 'english',
      task: 'transcribe',
    });
    const end = performance.now();

    const text = result.text.trim();
    if (text && text.length > 2) {
      console.log(`[Hearly-Offscreen] Local Transcript (${(end-start).toFixed(0)}ms):`, text);
      chrome.runtime.sendMessage({
        type: "MEETING_TRANSCRIPT",
        text: text,
        isFinal: true,
        speaker: 0, // Local Whisper tiny doesn't do diarization well
      });
    }
  } catch (err) {
    console.error("[Hearly-Offscreen] Inference error:", err);
  }
}

function stopLocalCapture() {
  if (source) source.disconnect();
  if (processor) processor.disconnect();
  if (audioContext) audioContext.close();
  audioBuffer = [];
  console.log("[Hearly-Offscreen] Local capture stopped.");
}
