const DEFAULT_LOCAL_STORAGE = {
  hearlyActive: false,
  hearlyEnrolled: false,
  voiceProfile: null,
  trainedAt: null,
  transcripts: [],
};

const DEFAULT_SYNC_STORAGE = {
  language: "en-US",
  notifyOnVoice: true,
  chimeOnFilter: false,
  deepgramApiKey: "",
};

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureDefaultStorage();

  if (details.reason === "install") {
    await chrome.storage.sync.set({
      language: "en-US",
      notifyOnVoice: true,
      chimeOnFilter: false,
    });
    await chrome.storage.local.set({
      transcripts: [],
      voiceProfile: null,
      hearlyEnrolled: false,
      hearlyActive: false,
    });
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaultStorage().catch((err) => {
    console.error("[Hearly] Failed to initialize storage defaults:", err);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "GET_STATE":
      chrome.storage.local.get(
        ["hearlyActive", "hearlyEnrolled", "voiceProfile", "trainedAt"],
        (local) => sendResponse(local)
      );
      return true;

    case "GET_SETTINGS":
      chrome.storage.sync.get(DEFAULT_SYNC_STORAGE, (settings) => {
        sendResponse(settings);
      });
      return true;

    case "SET_ACTIVE":
      chrome.storage.local.set({ hearlyActive: Boolean(message.value) });
      broadcastToMeetingTabs({ type: "HEARLY_TOGGLE", value: Boolean(message.value) });
      if (message.value) startMeetingTranscription(sender.tab?.id).catch(console.error);
      else stopMeetingTranscription().catch(console.error);
      sendResponse({ ok: true });
      return true;

    case "VOICE_ENROLLED": {
      const trainedAt = new Date().toISOString();
      chrome.storage.local.set({
        hearlyEnrolled: true,
        voiceProfile: message.profile,
        trainedAt,
      });
      broadcastToMeetingTabs({ type: "HEARLY_PROFILE_UPDATED", profile: message.profile });
      sendResponse({ ok: true });
      return true;
    }

    case "SAVE_TRANSCRIPT":
      appendTranscript(message.data || message)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "VOICE_DETECTED":
      handleVoiceDetected()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "GET_API_KEY":
      chrome.storage.sync.get("deepgramApiKey", (data) => {
        sendResponse({ key: data.deepgramApiKey || "" });
      });
      return true;

    case "SET_API_KEY":
      chrome.storage.sync.set({ deepgramApiKey: message.key || "" });
      sendResponse({ ok: true });
      return true;

    case "START_MEETING_TRANSCRIPTION":
      startMeetingTranscription(sender.tab?.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "STOP_MEETING_TRANSCRIPTION":
      stopMeetingTranscription()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "TRANSCRIPT":
      handleTranscriptMessage(message);
      sendResponse({ ok: true });
      return true;

    case "DEEPGRAM_ERROR":
      broadcastToMeetingTabs({ type: "DEEPGRAM_ERROR", reason: message.reason || "Deepgram connection error" });
      sendResponse({ ok: true });
      return true;

    case "TRANSCRIBE_AUDIO":
      sendResponse({ ok: true, text: "" });
      return true;
  }
});

async function startMeetingTranscription(tabId) {
  await ensureOffscreenDocument();

  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_TRANSCRIPTION",
    data: { tabId: tabId || null },
  });
}

async function stopMeetingTranscription() {
  if (!(await chrome.offscreen.hasDocument())) return;

  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "STOP_TRANSCRIPTION",
  });
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;

  await chrome.offscreen.createDocument({
    url: "src/offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capturing microphone audio for private Deepgram transcription.",
  });
}

function handleTranscriptMessage(message) {
  const text = String(message.text || "").trim();
  if (!text) return;

  broadcastToMeetingTabs({
    type: "TRANSCRIPT",
    text,
    isFinal: Boolean(message.isFinal),
  });

  if (message.isFinal) {
    appendTranscript({
      text,
      speaker: "nearby",
      duration: Number(message.duration || 0),
    }).catch((err) => console.error("[Hearly] Failed to save transcript:", err));
  }
}

async function appendTranscript(data) {
  const text = String(data.text || "").trim();
  if (!text) return;

  const transcript = {
    id: data.id || crypto.randomUUID(),
    text,
    speaker: data.speaker === "filtered" ? "filtered" : "nearby",
    timestamp: data.timestamp || new Date().toISOString(),
    duration: Number(data.duration || 0),
  };

  const stored = await chrome.storage.local.get("transcripts");
  const transcripts = Array.isArray(stored.transcripts) ? stored.transcripts : [];
  transcripts.push(transcript);
  await chrome.storage.local.set({ transcripts });
}

async function handleVoiceDetected() {
  const settings = await chrome.storage.sync.get(DEFAULT_SYNC_STORAGE);
  if (!settings.notifyOnVoice) return;

  chrome.notifications.create({
    type: "basic",
    iconUrl: "assets/icons/icon128.png",
    title: "Hearly",
    message: "Nearby voice detected and filtered",
  });
}

function broadcastToMeetingTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab.id || !isSupportedTabUrl(tab.url)) return;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

async function ensureDefaultStorage() {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(Object.keys(DEFAULT_LOCAL_STORAGE)),
    chrome.storage.sync.get(Object.keys(DEFAULT_SYNC_STORAGE)),
  ]);

  const localPatch = {};
  const syncPatch = {};

  for (const [key, value] of Object.entries(DEFAULT_LOCAL_STORAGE)) {
    if (typeof local[key] === "undefined") localPatch[key] = value;
  }

  for (const [key, value] of Object.entries(DEFAULT_SYNC_STORAGE)) {
    if (typeof sync[key] === "undefined") syncPatch[key] = value;
  }

  if (Object.keys(localPatch).length) await chrome.storage.local.set(localPatch);
  if (Object.keys(syncPatch).length) await chrome.storage.sync.set(syncPatch);
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
