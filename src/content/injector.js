// ─────────────────────────────────────────────
//  Hearly — Content Script Injector
//  Runs at document_start, hooks getUserMedia
//  before Google Meet / Zoom can call it
// ─────────────────────────────────────────────

(function () {
  "use strict";

  // ── Inject page-level script to hook getUserMedia ──
  // Content scripts can't directly override window.navigator.mediaDevices
  // so we inject a script tag into the page context
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/overlay.js");
  script.dataset.extensionId = chrome.runtime.id;
  (document.head || document.documentElement).appendChild(script);

  // ── Load overlay CSS ──────────────────────────────
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("src/content/overlay.css");
  (document.head || document.documentElement).appendChild(link);

  // ── Listen for messages from overlay.js (page context) ──
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (!event.data?.hearlyMsg) return;

    const msg = event.data;

    switch (msg.type) {
      case "HEARLY_GET_STORAGE": {
        const data = await getStorage([
          "hearlyActive",
          "hearlyEnrolled",
          "voiceProfile",
          "deepgramApiKey",
          "filterMode",
        ]);
        window.postMessage(
          { hearlyMsg: true, type: "HEARLY_STORAGE_DATA", data },
          "*"
        );
        break;
      }

      case "HEARLY_TRANSCRIBE": {
        // Forward audio to background for Deepgram API call
        const apiKeyData = await getStorage(["deepgramApiKey"]);
        const result = await chrome.runtime.sendMessage({
          type: "TRANSCRIBE_AUDIO",
          audioBase64: msg.audioBase64,
          apiKey: apiKeyData.deepgramApiKey,
        });
        window.postMessage(
          {
            hearlyMsg: true,
            type: "HEARLY_TRANSCRIPT_RESULT",
            text: result.text || "",
            requestId: msg.requestId,
          },
          "*"
        );
        break;
      }

      case "HEARLY_SAVE_TRANSCRIPT": {
        await chrome.runtime.sendMessage({
          type: "SAVE_TRANSCRIPT",
          text: msg.text,
        });
        break;
      }

      case "HEARLY_SAVE_PROFILE": {
        chrome.runtime.sendMessage({
          type: "VOICE_ENROLLED",
          profile: msg.profile,
        });
        break;
      }

      case "HEARLY_START_MEETING": {
        const result = await chrome.runtime.sendMessage({ type: "START_MEETING_TRANSCRIPTION" });
        window.postMessage(
          {
            hearlyMsg: true,
            type: "HEARLY_MEETING_CONTROL_RESULT",
            action: "start",
            ok: Boolean(result?.ok),
            error: result?.error || null,
          },
          "*"
        );
        break;
      }

      case "HEARLY_STOP_MEETING": {
        const result = await chrome.runtime.sendMessage({ type: "STOP_MEETING_TRANSCRIPTION" });
        window.postMessage(
          {
            hearlyMsg: true,
            type: "HEARLY_MEETING_CONTROL_RESULT",
            action: "stop",
            ok: Boolean(result?.ok),
            error: result?.error || null,
          },
          "*"
        );
        break;
      }
    }
  });

  // ── Listen for messages from background ──────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "HEARLY_TOGGLE") {
      window.postMessage(
        { hearlyMsg: true, type: "HEARLY_TOGGLE", value: message.value },
        "*"
      );
    } else if (message.type === "HEARLY_START_ENROLLMENT") {
      window.postMessage(
        { hearlyMsg: true, type: "HEARLY_ENROLL" },
        "*"
      );
    } else if (message.type === "HEARLY_PROFILE_UPDATED") {
      window.postMessage(
        { hearlyMsg: true, type: "HEARLY_PROFILE_UPDATED", profile: message.profile },
        "*"
      );
    } else if (message.type === "HEARLY_MEETING_TRANSCRIPT") {
      window.postMessage(
        { 
          hearlyMsg: true, 
          type: "HEARLY_MEETING_TRANSCRIPT", 
          text: message.text,
          isFinal: message.isFinal,
          speaker: message.speaker
        },
        "*"
      );
    } else if (message.type === "HEARLY_FILTER_MODE_UPDATED") {
      window.postMessage(
        {
          hearlyMsg: true,
          type: "HEARLY_FILTER_MODE_UPDATED",
          value: message.value,
        },
        "*"
      );
    } else if (message.type === "HEARLY_API_KEY_UPDATED") {
      window.postMessage(
        {
          hearlyMsg: true,
          type: "HEARLY_API_KEY_UPDATED",
          value: message.value,
        },
        "*"
      );
    } else if (message.type === "HEARLY_RESET") {
      window.postMessage(
        {
          hearlyMsg: true,
          type: "HEARLY_RESET",
        },
        "*"
      );
    }
  });

  function getStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }
})();
