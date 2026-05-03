(function () {
  "use strict";

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/overlay.js");
  script.dataset.extensionId = chrome.runtime.id;
  (document.head || document.documentElement).appendChild(script);

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("src/content/overlay.css");
  (document.head || document.documentElement).appendChild(link);

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data?.hearlyMsg) return;

    const msg = event.data;

    switch (msg.type) {
      case "HEARLY_GET_STORAGE": {
        const data = await getLocalStorage([
          "hearlyActive",
          "hearlyEnrolled",
          "voiceProfile",
          "trainedAt",
        ]);
        window.postMessage({ hearlyMsg: true, type: "HEARLY_STORAGE_DATA", data }, "*");
        break;
      }

      case "HEARLY_TRANSCRIBE": {
        const result = await chrome.runtime.sendMessage({
          type: "TRANSCRIBE_AUDIO",
          audioBase64: msg.audioBase64,
        });
        window.postMessage({
          hearlyMsg: true,
          type: "HEARLY_TRANSCRIPT_RESULT",
          text: result.text || "",
          requestId: msg.requestId,
        }, "*");
        break;
      }

      case "HEARLY_SAVE_PROFILE":
        chrome.runtime.sendMessage({
          type: "VOICE_ENROLLED",
          profile: msg.profile,
        });
        break;

      case "HEARLY_START_MEETING":
        chrome.runtime.sendMessage({ type: "START_MEETING_TRANSCRIPTION" });
        break;

      case "HEARLY_STOP_MEETING":
        chrome.runtime.sendMessage({ type: "STOP_MEETING_TRANSCRIPTION" });
        break;
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "HEARLY_TOGGLE") {
      window.postMessage({ hearlyMsg: true, type: "HEARLY_TOGGLE", value: message.value }, "*");
    } else if (message.type === "HEARLY_START_ENROLLMENT") {
      window.postMessage({ hearlyMsg: true, type: "HEARLY_ENROLL" }, "*");
    } else if (message.type === "HEARLY_PROFILE_UPDATED") {
      window.postMessage({
        hearlyMsg: true,
        type: "HEARLY_PROFILE_UPDATED",
        profile: message.profile,
      }, "*");
    } else if (message.type === "HEARLY_MEETING_TRANSCRIPT") {
      window.postMessage({
        hearlyMsg: true,
        type: "HEARLY_MEETING_TRANSCRIPT",
        text: message.text,
        isFinal: message.isFinal,
        speaker: message.speaker,
      }, "*");
    } else if (message.type === "TRANSCRIPT") {
      window.postMessage({
        hearlyMsg: true,
        type: "TRANSCRIPT",
        text: message.text,
        isFinal: message.isFinal,
      }, "*");
    } else if (message.type === "DEEPGRAM_ERROR") {
      window.postMessage({
        hearlyMsg: true,
        type: "DEEPGRAM_ERROR",
        reason: message.reason,
      }, "*");
    }
  });

  function getLocalStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }
})();
