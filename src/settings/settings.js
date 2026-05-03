document.addEventListener("DOMContentLoaded", async () => {
  const steps = Array.from(document.querySelectorAll(".step"));
  const dots = Array.from(document.querySelectorAll(".progress-dots span"));
  const apiKeyInput = document.getElementById("api-key");
  const testKeyBtn = document.getElementById("test-key-btn");
  const keyStatus = document.getElementById("key-status");
  const languageSelect = document.getElementById("language");
  const notifyOnVoice = document.getElementById("notify-on-voice");
  const chimeOnFilter = document.getElementById("chime-on-filter");
  const backBtn = document.getElementById("back-btn");
  const nextBtn = document.getElementById("next-btn");
  const openHearlyBtn = document.getElementById("open-hearly-btn");
  const summaryKey = document.getElementById("summary-key");
  const summaryLanguage = document.getElementById("summary-language");
  const summaryNotifications = document.getElementById("summary-notifications");

  let currentStep = 0;
  let apiKeyValid = false;

  const settings = await chrome.storage.sync.get([
    "deepgramApiKey",
    "language",
    "notifyOnVoice",
    "chimeOnFilter",
  ]);

  apiKeyInput.value = settings.deepgramApiKey || "";
  languageSelect.value = settings.language || "en-US";
  notifyOnVoice.checked = typeof settings.notifyOnVoice === "boolean" ? settings.notifyOnVoice : true;
  chimeOnFilter.checked = Boolean(settings.chimeOnFilter);
  apiKeyValid = Boolean(settings.deepgramApiKey);

  render();

  apiKeyInput.addEventListener("input", () => {
    apiKeyValid = false;
    keyStatus.textContent = "";
    keyStatus.className = "key-status";
    renderActions();
  });

  testKeyBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      setKeyStatus("✗ Invalid", false);
      return;
    }

    testKeyBtn.disabled = true;
    keyStatus.textContent = "Testing...";
    keyStatus.className = "key-status";

    try {
      const response = await fetch("https://api.deepgram.com/v1/projects", {
        method: "GET",
        headers: {
          Authorization: `Token ${key}`,
        },
      });

      apiKeyValid = response.ok;
      if (apiKeyValid) {
        await chrome.storage.sync.set({ deepgramApiKey: key });
        setKeyStatus("✓ Valid", true);
      } else {
        setKeyStatus("✗ Invalid", false);
      }
    } catch (err) {
      console.error("[Hearly Settings] API key test failed:", err);
      apiKeyValid = false;
      setKeyStatus("✗ Invalid", false);
    } finally {
      testKeyBtn.disabled = false;
      renderActions();
    }
  });

  languageSelect.addEventListener("change", async () => {
    await chrome.storage.sync.set({ language: languageSelect.value });
  });

  notifyOnVoice.addEventListener("change", saveNotificationSettings);
  chimeOnFilter.addEventListener("change", saveNotificationSettings);

  backBtn.addEventListener("click", () => {
    if (currentStep > 0) {
      currentStep -= 1;
      render();
    }
  });

  nextBtn.addEventListener("click", async () => {
    if (currentStep === 0 && !apiKeyValid) return;

    if (currentStep === 1) {
      await chrome.storage.sync.set({ language: languageSelect.value });
    }

    if (currentStep === 2) {
      await saveNotificationSettings();
      populateSummary();
    }

    if (currentStep < steps.length - 1) {
      currentStep += 1;
      render();
    }
  });

  openHearlyBtn.addEventListener("click", async () => {
    if (chrome.action?.openPopup) {
      try {
        await chrome.action.openPopup();
      } catch (err) {
        console.warn("[Hearly Settings] Could not open popup directly:", err);
      }
    }
    window.close();
  });

  async function saveNotificationSettings() {
    await chrome.storage.sync.set({
      notifyOnVoice: notifyOnVoice.checked,
      chimeOnFilter: chimeOnFilter.checked,
    });
  }

  function render() {
    steps.forEach((step, index) => {
      step.classList.toggle("active", index === currentStep);
    });

    dots.forEach((dot, index) => {
      dot.classList.toggle("active", index === currentStep);
      dot.classList.toggle("done", index < currentStep);
    });

    if (currentStep === 3) populateSummary();
    renderActions();
  }

  function renderActions() {
    backBtn.disabled = currentStep === 0;
    backBtn.hidden = currentStep === 3;
    nextBtn.hidden = currentStep === 3;
    openHearlyBtn.hidden = currentStep !== 3;
    nextBtn.disabled = currentStep === 0 && !apiKeyValid;
  }

  function populateSummary() {
    const key = apiKeyInput.value.trim();
    summaryKey.textContent = key ? maskKey(key) : "Not saved";
    summaryLanguage.textContent = languageSelect.options[languageSelect.selectedIndex]?.textContent || "English (en-US)";
    summaryNotifications.textContent = `${notifyOnVoice.checked ? "Desktop on" : "Desktop off"}, ${chimeOnFilter.checked ? "chime on" : "chime off"}`;
  }

  function setKeyStatus(text, valid) {
    keyStatus.textContent = text;
    keyStatus.className = `key-status ${valid ? "valid" : "invalid"}`;
  }

  function maskKey(key) {
    if (key.length <= 8) return "••••";
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
  }
});
