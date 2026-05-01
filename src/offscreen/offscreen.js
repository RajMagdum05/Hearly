// ─────────────────────────────────────────────
//  Hearly — Offscreen Audio Processor
//  Hybrid: Handles Local Whisper OR Cloud Deepgram
// ─────────────────────────────────────────────

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers';

// Configuration for local environment
env.allowLocalModels = false;
env.useBrowserCache = true;

// Shared State
let audioContext = null;
let source = null;
let processor = null;
let activeStream = null;

// Local Whisper State
let transcriber = null;
let audioBuffer = [];
const CHUNK_THRESHOLD = 16000 * 4; // 4 seconds

// Cloud Deepgram State
let socket = null;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== "offscreen") return;

  if (message.type === "START_TAB_RECORDING") {
    const { streamId, apiKey } = message.data;
    if (apiKey) {
      console.log("[Hearly-Offscreen] Starting Cloud Transcription (Deepgram)...");
      startCloudCapture(streamId, apiKey);
    } else {
      console.log("[Hearly-Offscreen] Starting Local Transcription (Whisper)...");
      startLocalCapture(streamId);
    }
  } else if (message.type === "STOP_TAB_RECORDING") {
    stopAllCapture();
  }
});

// ── Shared Utilities ───────────────────────────

async function getTabStream(streamId) {
  return await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });
}

function stopAllCapture() {
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "CloseStream" }));
    }
    socket.close();
    socket = null;
  }
  if (processor) processor.disconnect();
  if (source) source.disconnect();
  if (audioContext) audioContext.close();
  
  audioContext = null;
  source = null;
  processor = null;
  activeStream = null;
  audioBuffer = [];

  console.log("[Hearly-Offscreen] All capture stopped.");
}

// ── Cloud (Deepgram) Implementation ────────────

async function startCloudCapture(streamId, apiKey) {
  try {
    activeStream = await getTabStream(streamId);
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(activeStream);
    source.connect(audioContext.destination);

    const url = "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&diarize=true&smart_format=true&interim_results=true";
    socket = new WebSocket(url, ["token", apiKey]);

    socket.onopen = () => {
      console.log("[Hearly-Offscreen] Deepgram WebSocket opened");
      
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmData = floatTo16BitPCM(inputData);
          socket.send(pcmData);
        }
      };
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.channel?.alternatives?.[0]?.transcript) {
        chrome.runtime.sendMessage({
          type: "MEETING_TRANSCRIPT",
          text: data.channel.alternatives[0].transcript,
          isFinal: data.is_final,
          speaker: data.channel.alternatives[0].words?.[0]?.speaker ?? 0,
        });
      }
    };

    socket.onerror = (err) => console.error("[Hearly-Offscreen] Deepgram Error:", err);
    socket.onclose = () => console.log("[Hearly-Offscreen] Deepgram WebSocket closed");

  } catch (err) {
    console.error("[Hearly-Offscreen] Cloud capture failed:", err);
  }
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output.buffer;
}

// ── Local (Whisper) Implementation ────────────

async function ensureTranscriber() {
  if (transcriber) return;
  console.log("[Hearly-Offscreen] Loading Local Whisper Model...");
  try {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    console.log("[Hearly-Offscreen] Local Whisper Model Loaded.");
  } catch (err) {
    console.error("[Hearly-Offscreen] Model Load Failed:", err);
  }
}

async function startLocalCapture(streamId) {
  await ensureTranscriber();

  try {
    activeStream = await getTabStream(streamId);
    audioContext = new AudioContext({ sampleRate: 16000 });
    source = audioContext.createMediaStreamSource(activeStream);
    source.connect(audioContext.destination);

    processor = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      audioBuffer.push(...input);

      if (audioBuffer.length >= CHUNK_THRESHOLD) {
        const toProcess = new Float32Array(audioBuffer);
        audioBuffer = [];
        runInference(toProcess);
      }
    };

    console.log("[Hearly-Offscreen] Local capture started.");
  } catch (err) {
    console.error("[Hearly-Offscreen] Local capture failed:", err);
  }
}

async function runInference(samples) {
  if (!transcriber) return;
  try {
    const result = await transcriber(samples, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: 'english',
      task: 'transcribe',
    });

    const text = result.text.trim();
    if (text && text.length > 2) {
      chrome.runtime.sendMessage({
        type: "MEETING_TRANSCRIPT",
        text: text,
        isFinal: true,
        speaker: 0,
      });
    }
  } catch (err) {
    console.error("[Hearly-Offscreen] Inference error:", err);
  }
}
