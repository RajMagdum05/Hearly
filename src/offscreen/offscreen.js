// ─────────────────────────────────────────────
//  Hearly — Offscreen Audio Processor
//  Handles tabCapture streams and Deepgram WS
// ─────────────────────────────────────────────

let mediaRecorder;
let socket;
let audioContext;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== "offscreen") return;

  if (message.type === "START_TAB_RECORDING") {
    startCapture(message.data.streamId, message.data.apiKey);
  } else if (message.type === "STOP_TAB_RECORDING") {
    stopCapture();
  }
});

async function startCapture(streamId, apiKey) {
  if (socket || mediaRecorder) {
    console.warn("[Hearly-Offscreen] Capture already in progress, stopping old one.");
    stopCapture();
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    // ── 1. Keep audio audible to the user ────────────────
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);

    // ── 2. Initialize Deepgram WebSocket ────────────────
    const url = "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&diarize=true&smart_format=true&interim_results=true";
    
    socket = new WebSocket(url, ["token", apiKey]);

    socket.onopen = () => {
      console.log("[Hearly-Offscreen] Deepgram WebSocket opened");
      startStreaming(stream);
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.channel?.alternatives?.[0]?.transcript) {
        const transcript = data.channel.alternatives[0].transcript;
        const isFinal = data.is_final;
        const speaker = data.channel.alternatives[0].words?.[0]?.speaker ?? 0;

        chrome.runtime.sendMessage({
          type: "MEETING_TRANSCRIPT",
          text: transcript,
          isFinal,
          speaker,
        });
      }
    };

    socket.onerror = (error) => {
      console.error("[Hearly-Offscreen] Deepgram WebSocket error:", error);
    };

    socket.onclose = () => {
      console.log("[Hearly-Offscreen] Deepgram WebSocket closed");
    };

  } catch (err) {
    console.error("[Hearly-Offscreen] Failed to start capture:", err);
  }
}

function startStreaming(stream) {
  // Use a ScriptProcessor or AudioWorklet to get raw PCM
  // ScriptProcessor is deprecated but easier for a quick MVP in offscreen
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const source = audioContext.createMediaStreamSource(stream);
  
  source.connect(processor);
  processor.connect(audioContext.destination); // Required to keep it alive

  processor.onaudioprocess = (e) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmData = floatTo16BitPCM(inputData);
      socket.send(pcmData);
    }
  };

  mediaRecorder = {
    stop: () => {
      source.disconnect();
      processor.disconnect();
    }
  };
}

function stopCapture() {
  if (mediaRecorder) {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "CloseStream" }));
    }
    socket.close();
    socket = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  console.log("[Hearly-Offscreen] Capture stopped");
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output.buffer;
}
