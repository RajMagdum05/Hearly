// ─────────────────────────────────────────────
//  Hearly — Offscreen Audio Processor
//  Handles tabCapture streams and Deepgram WS
// ─────────────────────────────────────────────

let mediaRecorder = null;
let socket = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let capturedStream = null;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== "offscreen") return;

  if (message.type === "START_TAB_RECORDING") {
    startCapture(message.data.streamId, message.data.apiKey);
  } else if (message.type === "STOP_TAB_RECORDING") {
    stopCapture();
  }
});

async function startCapture(streamId, apiKey) {
  if (socket || mediaRecorder || audioContext) {
    console.warn("[Hearly-Offscreen] Capture already in progress, stopping old session.");
    stopCapture();
  }

  if (!apiKey) {
    throw new Error("Deepgram API key is required for meeting transcription.");
  }

  try {
    capturedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    sourceNode = audioContext.createMediaStreamSource(capturedStream);
    sourceNode.connect(audioContext.destination);

    socket = new WebSocket(
      "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&diarize=true&smart_format=true&interim_results=true",
      ["token", apiKey]
    );

    socket.onopen = () => {
      console.log("[Hearly-Offscreen] Deepgram WebSocket opened");
      startStreaming();
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript) return;

      chrome.runtime.sendMessage({
        type: "MEETING_TRANSCRIPT",
        text: transcript,
        isFinal: Boolean(data.is_final),
        speaker: data.channel?.alternatives?.[0]?.words?.[0]?.speaker ?? 0,
      });
    };

    socket.onerror = (error) => {
      console.error("[Hearly-Offscreen] Deepgram WebSocket error:", error);
    };

    socket.onclose = () => {
      console.log("[Hearly-Offscreen] Deepgram WebSocket closed");
    };
  } catch (err) {
    console.error("[Hearly-Offscreen] Failed to start capture:", err);
    stopCapture();
  }
}

function startStreaming() {
  if (!audioContext || !sourceNode) return;

  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  processorNode.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const inputData = event.inputBuffer.getChannelData(0);
    socket.send(floatTo16BitPCM(inputData));
  };

  mediaRecorder = {
    stop: () => {
      try {
        sourceNode?.disconnect(processorNode);
      } catch {}
      try {
        processorNode?.disconnect();
      } catch {}
      processorNode = null;
    },
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

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {}
    sourceNode = null;
  }

  if (capturedStream) {
    capturedStream.getTracks().forEach((track) => track.stop());
    capturedStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  console.log("[Hearly-Offscreen] Capture stopped");
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}
