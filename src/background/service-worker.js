// ─────────────────────────────────────────────
//  Hearly — Background Service Worker
//  Manages state, STT API calls, tab messaging
// ─────────────────────────────────────────────

const CONFIGURED_DEEPGRAM_API_KEY = "c8737059b2488d3ef85c670e71b91f8105b62424";

const DEFAULT_STORAGE = {
  hearlyActive: false,
  hearlyEnrolled: false,
  voiceProfile: null,
  deepgramApiKey: CONFIGURED_DEEPGRAM_API_KEY,
  transcriptHistory: [],
  filterMode: "smart",
};

let meetingSessionTabId = null;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultStorage();
  console.log("[Hearly] Extension installed.");
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaultStorage().catch((err) => {
    console.error("[Hearly] Failed to initialize storage defaults:", err);
  });
});

// ── Message Router ────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case "GET_STATE":
      chrome.storage.local.get(
        ["hearlyActive", "hearlyEnrolled", "deepgramApiKey", "filterMode"],
        (data) => sendResponse({
          ...data,
          deepgramApiKey: resolveConfiguredApiKey(data.deepgramApiKey),
        })
      );
      return true;

    case "SET_ACTIVE":
      chrome.storage.local.set({ hearlyActive: message.value });
      broadcastToMeetingTabs({ type: "HEARLY_TOGGLE", value: message.value });
      sendResponse({ ok: true });
      return true;

    case "SET_FILTER_MODE":
      chrome.storage.local.set({ filterMode: message.value });
      broadcastToMeetingTabs({ type: "HEARLY_FILTER_MODE_UPDATED", value: message.value });
      sendResponse({ ok: true });
      return true;

    case "VOICE_ENROLLED":
      chrome.storage.local.set({
        hearlyEnrolled: true,
        voiceProfile: message.profile,
      });
      broadcastToMeetingTabs({ type: "HEARLY_PROFILE_UPDATED", profile: message.profile });
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
        sendResponse({ key: resolveConfiguredApiKey(d.deepgramApiKey) })
      );
      return true;

    case "SET_API_KEY":
      chrome.storage.local.set({ deepgramApiKey: message.key });
      broadcastToMeetingTabs({ type: "HEARLY_API_KEY_UPDATED", value: message.key || "" });
      sendResponse({ ok: true });
      return true;

    case "START_MEETING_TRANSCRIPTION":
      startMeetingTranscription(sender.tab.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "STOP_MEETING_TRANSCRIPTION":
      stopMeetingTranscription(sender.tab?.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "MEETING_TRANSCRIPT":
      relayMeetingTranscript(message);
      return true;

    case "RESET_HEARLY_STATE":
      resetHearlyState()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
  }
});

// ── Meeting Transcription Management ──────────
async function startMeetingTranscription(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const { deepgramApiKey } = await chrome.storage.local.get("deepgramApiKey");
  const resolvedApiKey = resolveConfiguredApiKey(deepgramApiKey);

  if (meetingSessionTabId && meetingSessionTabId !== tabId) {
    throw new Error("Meeting transcription is already running in another tab.");
  }

  if (!resolvedApiKey) {
    throw new Error("Cloud transcription is off. Filtering still works without a key.");
  }

  await ensureOffscreenDocument();
  meetingSessionTabId = tabId;

  chrome.runtime.sendMessage({
    type: "START_TAB_RECORDING",
    target: "offscreen",
    data: { streamId, apiKey: resolvedApiKey }
  });
}

async function stopMeetingTranscription(tabId) {
  if (meetingSessionTabId && tabId && meetingSessionTabId !== tabId) {
    throw new Error("Meeting transcription belongs to another tab.");
  }

  chrome.runtime.sendMessage({
    type: "STOP_TAB_RECORDING",
    target: "offscreen"
  });
  meetingSessionTabId = null;
  await closeOffscreenDocument();
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;

  await chrome.offscreen.createDocument({
    url: "src/offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capturing tab audio for meeting transcription."
  });
}

async function closeOffscreenDocument() {
  if (!(await chrome.offscreen.hasDocument())) return;
  await chrome.offscreen.closeDocument();
  meetingSessionTabId = null;
}

// ── Transcription via Deepgram REST ───────────
async function handleTranscription(audioBase64, apiKey) {
  const resolvedApiKey = resolveConfiguredApiKey(apiKey);
  if (!resolvedApiKey) {
    return "";
  }

  try {
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
          Authorization: `Token ${resolvedApiKey}`,
          "Content-Type": "audio/wav",
        },
        body: bytes.buffer,
      }
    );

    if (!response.ok) {
      if (response.status === 401) return "❌ [Invalid Deepgram API Key]";
      throw new Error(`Deepgram error: ${response.status}`);
    }

    const data = await response.json();
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    
    const result = transcript.trim();
    if (result) console.log("[Hearly] Transcription successful:", result);
    return result;
    
  } catch (err) {
    console.error("[Hearly] Transcription error:", err);
    return `❌ [Transcription Error: ${err.message}]`;
  }
}

// ── Save transcript to history ─────────────────
function saveTranscript(text) {
  if (
    !text ||
    /^\s*$/.test(text) ||
    text.startsWith("⚠️") ||
    text.startsWith("❌")
  ) {
    return;
  }

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

function relayMeetingTranscript(message) {
  if (!meetingSessionTabId) return;

  chrome.tabs.sendMessage(meetingSessionTabId, {
    type: "HEARLY_MEETING_TRANSCRIPT",
    text: message.text,
    isFinal: message.isFinal,
    speaker: message.speaker,
  }).catch(() => {});
}

async function resetHearlyState() {
  await stopMeetingTranscription();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    ...DEFAULT_STORAGE,
    transcriptHistory: [],
  });

  broadcastToMeetingTabs({ type: "HEARLY_RESET" });
}

// ── Broadcast to all meeting tabs ─────────────
function broadcastToMeetingTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (isSupportedTabUrl(tab.url)) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    });
  });
}

async function ensureDefaultStorage() {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_STORAGE));
  const patch = {};

  for (const [key, value] of Object.entries(DEFAULT_STORAGE)) {
    if (typeof existing[key] === "undefined") {
      patch[key] = value;
    }
  }

  if (!existing.deepgramApiKey) {
    patch.deepgramApiKey = CONFIGURED_DEEPGRAM_API_KEY;
  }

  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
}

function resolveConfiguredApiKey(value) {
  return value || CONFIGURED_DEEPGRAM_API_KEY || "";
}

function isSupportedTabUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "meet.google.com" ||
      parsed.hostname === "teams.microsoft.com" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "zoom.us" ||
      parsed.hostname.endsWith(".zoom.us")
    );
  } catch {
    return false;
  }
}
