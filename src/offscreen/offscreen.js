let mediaRecorder = null;
let micStream = null;
let socket = null;
let recordingStartedAt = 0;

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;

  if (message.type === "START_TRANSCRIPTION" || message.type === "START_TAB_RECORDING") {
    startTranscription().catch((err) => {
      sendDeepgramError(err.message || "Could not start transcription");
    });
  }

  if (message.type === "STOP_TRANSCRIPTION" || message.type === "STOP_TAB_RECORDING") {
    stopTranscription();
  }
});

async function startTranscription() {
  stopTranscription();

  const settings = await chrome.storage.sync.get(["deepgramApiKey", "language"]);
  const apiKey = settings.deepgramApiKey || "";
  const language = settings.language || "en-US";

  if (!apiKey) {
    throw new Error("Deepgram API key is missing. Open Hearly settings to add one.");
  }

  const params = new URLSearchParams({
    model: "nova-2",
    language,
    punctuate: "true",
    interim_results: "true",
    token: apiKey,
  });

  socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`);

  socket.onopen = async () => {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const options = getMediaRecorderOptions();
      mediaRecorder = new MediaRecorder(micStream, options);
      recordingStartedAt = Date.now();

      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size && socket?.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      });

      mediaRecorder.addEventListener("stop", () => {
        micStream?.getTracks().forEach((track) => track.stop());
        micStream = null;
      });

      mediaRecorder.start(250);
      console.log("[Hearly-Offscreen] Deepgram transcription started.");
    } catch (err) {
      sendDeepgramError(err.message || "Microphone capture failed");
      stopTranscription();
    }
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const text = data?.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = Boolean(data?.is_final);

      if (text.trim()) {
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT",
          text,
          isFinal,
          duration: isFinal ? Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000)) : 0,
        });
      }
    } catch (err) {
      sendDeepgramError(err.message || "Could not parse Deepgram response");
    }
  };

  socket.onerror = () => {
    sendDeepgramError("Deepgram WebSocket error");
  };

  socket.onclose = (event) => {
    if (!event.wasClean && event.code !== 1000) {
      sendDeepgramError(event.reason || `Deepgram WebSocket closed with code ${event.code}`);
    }
  };
}

function stopTranscription() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  mediaRecorder = null;

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "CloseStream" }));
    }
    socket.close(1000, "Hearly stopped");
    socket = null;
  }
}

function getMediaRecorderOptions() {
  const mimeType = "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType };
  return {};
}

function sendDeepgramError(reason) {
  chrome.runtime.sendMessage({
    type: "DEEPGRAM_ERROR",
    reason,
  });
}

globalThis.startTranscription = startTranscription;
globalThis.stopTranscription = stopTranscription;
