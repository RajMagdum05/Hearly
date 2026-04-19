// ─────────────────────────────────────────────
//  Hearly — Background Service Worker
//  Manages state, STT API calls, tab messaging
// ─────────────────────────────────────────────

const HEARLY_STATE = {
  isActive: false,
  isEnrolled: false,
  deepgramApiKey: null,
};

// ── On install: set defaults ──────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    hearlyActive: false,
    hearlyEnrolled: false,
    voiceProfile: {
      mfccMeans: Array(13).fill(0),
      mfccStds: Array(13).fill(1),
      enrolledAt: new Date().toISOString()
    },
    deepgramApiKey: null,
    transcriptHistory: [],
  });
  console.log("[Hearly] Extension installed.");
});

// ── Message Router ────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case "GET_STATE":
      chrome.storage.local.get(
        ["hearlyActive", "hearlyEnrolled", "deepgramApiKey"],
        (data) => sendResponse(data)
      );
      return true;

    case "SET_ACTIVE":
      chrome.storage.local.set({ hearlyActive: message.value });
      broadcastToMeetingTabs({ type: "HEARLY_TOGGLE", value: message.value });
      sendResponse({ ok: true });
      return true;

    case "VOICE_ENROLLED":
      chrome.storage.local.set({
        hearlyEnrolled: true,
        voiceProfile: message.profile,
      });
      sendResponse({ ok: true });
      return true;

    case "TRANSCRIBE_AUDIO":
      // Background person's audio chunks sent here for STT
      handleTranscription(message.audioBase64, message.apiKey)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "SAVE_TRANSCRIPT":
      saveTranscript(message.text);
      sendResponse({ ok: true });
      return true;

    case "GET_API_KEY":
      chrome.storage.local.get("deepgramApiKey", (d) =>
        sendResponse({ key: d.deepgramApiKey })
      );
      return true;

    case "SET_API_KEY":
      chrome.storage.local.set({ deepgramApiKey: message.key });
      sendResponse({ ok: true });
      return true;
  }
});

// ── Transcription via Deepgram REST ───────────
async function handleTranscription(audioBase64, apiKey) {
  if (!apiKey) {
    console.warn("[Hearly] No Deepgram API key set.");
    return "[No API key configured]";
  }

  // Convert base64 → binary
  const binaryStr = atob(audioBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const response = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: bytes.buffer,
    }
  );

  if (!response.ok) {
    throw new Error(`Deepgram error: ${response.status}`);
  }

  const data = await response.json();
  const transcript =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return transcript.trim();
}

// ── Save transcript to history ─────────────────
function saveTranscript(text) {
  chrome.storage.local.get("transcriptHistory", (data) => {
    const history = data.transcriptHistory || [];
    history.push({
      text,
      timestamp: new Date().toISOString(),
    });
    // Keep last 100 entries
    if (history.length > 100) history.shift();
    chrome.storage.local.set({ transcriptHistory: history });
  });
}

// ── Broadcast to all meeting tabs ─────────────
function broadcastToMeetingTabs(message) {
  const meetPatterns = [
    "https://meet.google.com/*",
    "https://*.zoom.us/*",
    "https://teams.microsoft.com/*",
  ];

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (
        tab.url &&
        meetPatterns.some((p) => {
          const domain = p.replace("https://", "").replace("/*", "");
          return tab.url.includes(domain.replace("*.", ""));
        })
      ) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    });
  });
}
