// ─────────────────────────────────────────────
//  Hearly — Popup Script
// ─────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const SUPPORTED_HOSTS = [
    "meet.google.com",
    "zoom.us",
    "teams.microsoft.com",
    "localhost",
  ];

  // ── Elements ──────────────────────────────
  const mainToggle     = document.getElementById("main-toggle");
  const statusDot      = document.getElementById("status-dot");
  const statusLabel    = document.getElementById("status-label");
  const statusSublabel = document.getElementById("status-sublabel");
  const enrollBtn      = document.getElementById("enroll-btn");
  const enrollCard     = document.getElementById("enroll-card");
  const enrollTitle    = document.getElementById("enroll-title");
  const enrollDesc     = document.getElementById("enroll-desc");
  const apiKeyInput    = document.getElementById("api-key-input");
  const saveKeyBtn     = document.getElementById("save-key-btn");
  const showKeyBtn     = document.getElementById("show-key-btn");
  const resetBtn       = document.getElementById("reset-btn");
  const notification   = document.getElementById("notification");
  const historyContent = document.getElementById("history-content");
  const notOnMeeting   = document.getElementById("not-on-meeting");
  const statusCard     = document.getElementById("status-card");
  const heroCheckText  = document.getElementById("hero-check-text");
  const micQuality     = document.getElementById("mic-quality");
  const toggleCopy     = document.getElementById("toggle-copy");
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel  = document.getElementById("settings-panel");
  const closeSettingsBtn = document.getElementById("close-settings-btn");
  const viewTranscriptsBtn = document.getElementById("view-transcripts-btn");
  const transcriptHistoryPanel = document.getElementById("transcript-history-panel");
  const voicesFilteredCount = document.getElementById("voices-filtered-count");
  const transcriptsCount = document.getElementById("transcripts-count");
  const modeButtons = Array.from(document.querySelectorAll("[data-mode]"));

  let currentState = {
    hearlyActive: false,
    hearlyEnrolled: false,
    deepgramApiKey: "",
    transcriptHistory: [],
  };
  let selectedMode = "smart";

  // ── Load stored state ─────────────────────
  currentState = await loadState();
  mainToggle.checked = currentState.hearlyActive;
  apiKeyInput.value  = currentState.deepgramApiKey;

  // ── Check if on meeting page ───────────────
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onMeeting = isSupportedMeetingUrl(tab?.url);

  if (!onMeeting) {
    notOnMeeting.style.display = "block";
    statusCard.style.opacity = "0.7";
  }

  syncUI();

  const modeBadge = document.createElement("div");
  modeBadge.style.cssText = "font-size: 10px; opacity: 0.6; margin-top: 5px; text-align: center;";
  modeBadge.textContent = currentState.deepgramApiKey ? "🚀 Cloud Mode Active" : "";
  statusCard.appendChild(modeBadge);

  // ── Toggle Hearly on/off ───────────────────
  mainToggle.addEventListener("change", async () => {
    const value = mainToggle.checked;
    await chrome.runtime.sendMessage({ type: "SET_ACTIVE", value });
    currentState.hearlyActive = value;
    syncUI();
    showNotification(
      value ? "🟢 Hearly is now filtering your mic" : "⚫ Hearly paused",
      value ? "success" : "info"
    );
  });

  enrollBtn.addEventListener("click", async () => {
    // Trigger enrollment in the active tab
    try {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!currentTab?.id) {
        showNotification("❌ No active tab found.", "error");
        return;
      }

      // Check for restricted URLs (chrome://, edge://, about:, etc.)
      const restrictedSchemes = ["chrome:", "edge:", "about:", "chrome-extension:", "moz-extension:"];
      if (currentTab.url && restrictedSchemes.some(scheme => currentTab.url.startsWith(scheme))) {
        showNotification("❌ Setup cannot run on browser system pages. Please open a meeting tab first.", "error");
        return;
      }

      if (!isSupportedMeetingUrl(currentTab.url)) {
        showNotification("❌ Please open Google Meet, Zoom, or Teams to start setup.", "error");
        return;
      }

      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => {
           if (window.__hearlyEnroll) {
               window.__hearlyEnroll();
           } else {
               alert("Hearly overlay not found on this page. Please refresh the meeting tab or ensure you are on a supported meeting site.");
           }
        },
      });
      
      showNotification("🎙️ Setup started on the page! Please switch to your meeting tab.", "success");
      // Keep popup open so they can read the message
    } catch (err) {
      console.error("[Hearly Popup] Enroll error:", err);
      if (err.message && err.message.includes("Cannot access")) {
        showNotification("❌ Hearly cannot access this page. Please try on Google Meet or Zoom.", "error");
      } else {
        showNotification("❌ Could not start training. Check permissions or refresh the tab.", "error");
      }
    } finally {
      enrollBtn.disabled = false;
    }
  });

  // ── Save API key ───────────────────────────
  saveKeyBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showNotification("Please enter your Deepgram API key", "error");
      return;
    }
    await chrome.runtime.sendMessage({ type: "SET_API_KEY", key });
    showNotification("🔑 API key saved! (Switching to High-Accuracy Cloud Mode)", "success");
  });

  // ── Show/hide API key ──────────────────────
  showKeyBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    showKeyBtn.textContent = apiKeyInput.type === "password" ? "Show" : "Hide";
  });

  settingsToggle?.addEventListener("click", () => {
    settingsPanel.classList.toggle("open");
  });

  closeSettingsBtn?.addEventListener("click", () => {
    settingsPanel.classList.remove("open");
  });

  viewTranscriptsBtn?.addEventListener("click", () => {
    settingsPanel.classList.add("open");
    transcriptHistoryPanel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedMode = button.dataset.mode || "smart";
      syncModeButtons();
      if (selectedMode === "off" && currentState.hearlyActive) {
        mainToggle.click();
      }
    });
  });

  // ── Reset everything ───────────────────────
  resetBtn.addEventListener("click", async () => {
    if (!confirm("Reset all Hearly data including voice profile?")) return;
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      hearlyActive: false,
      hearlyEnrolled: false,
      voiceProfile: null,
      deepgramApiKey: "",
      transcriptHistory: [],
    });
    showNotification("🔄 Reset complete", "info");
    setTimeout(() => window.location.reload(), 1500);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    for (const [key, change] of Object.entries(changes)) {
      currentState[key] = change.newValue;
    }

    syncUI();
  });

  window.addEventListener("focus", async () => {
    currentState = await loadState();
    syncUI();
  });

  // ═══════════════════════════════════════════
  //  HELPER FUNCTIONS
  // ═══════════════════════════════════════════

  function updateStatus(active, enrolled) {
    const effectiveActive = active && enrolled && onMeeting && selectedMode !== "off";

    if (!enrolled) {
      statusDot.textContent = "Setup Needed";
      statusLabel.textContent = "Voice Not Trained";
      statusSublabel.textContent = "Train your voice before Hearly can tell you apart from nearby speakers.";
      heroCheckText.textContent = "Voice profile required";
      micQuality.textContent = "Needs setup";
      toggleCopy.textContent = "Complete Setup";
      mainToggle.disabled = true;
    } else if (effectiveActive) {
      statusDot.textContent = "Active";
      statusLabel.textContent = "Filtering On";
      statusSublabel.textContent = "Filtering background voices while preserving your speech for the call.";
      heroCheckText.textContent = "Filtering background voices";
      micQuality.textContent = selectedMode === "strict" ? "Strict" : "Good";
      toggleCopy.textContent = "Pause Filtering";
      mainToggle.disabled = !onMeeting;
    } else {
      statusDot.textContent = selectedMode === "off" ? "Paused" : "Ready";
      statusLabel.textContent = selectedMode === "off" ? "Filtering Off" : "Ready to Filter";
      statusSublabel.textContent = onMeeting
        ? "Turn filtering on whenever you want Hearly to protect the meeting from nearby voices."
        : "Join a supported meeting to start live filtering.";
      heroCheckText.textContent = onMeeting ? "Protection ready when you are" : "Open a supported meeting tab";
      micQuality.textContent = onMeeting ? "Standby" : "Unavailable";
      toggleCopy.textContent = onMeeting ? "Enable Filtering" : "Meeting Required";
      mainToggle.disabled = !onMeeting;
    }
  }

  function updateEnrollCard(enrolled) {
    if (enrolled) {
      enrollTitle.textContent = "Voice profile ready";
      enrollDesc.textContent = "Hearly recognizes your voice now. Re-train anytime if your setup changes.";
      enrollBtn.textContent = "Re-train Voice";
      enrollBtn.className = "secondary-button";
    } else {
      enrollTitle.textContent = "Voice not trained";
      enrollDesc.textContent = "Train Hearly to recognize your voice before enabling filtering.";
      enrollBtn.textContent = "Train My Voice";
      enrollBtn.className = "primary-button";
    }
  }

  function renderHistory(history) {
    if (!history || history.length === 0) {
      historyContent.innerHTML = '<div class="history-empty">No transcripts yet</div>';
      return;
    }

    const recent = history.slice(-5).reverse();
    historyContent.innerHTML = `
      <div class="history-list">
        ${recent.map((item) => `
          <div class="history-item">
            <div class="history-item-time">${new Date(item.timestamp).toLocaleTimeString()}</div>
            ${escapeHtml(item.text)}
          </div>
        `).join("")}
      </div>
    `;
  }

  function showNotification(message, type = "info") {
    notification.textContent = message;
    notification.className = `notification visible ${type}`;
    setTimeout(() => {
      notification.classList.remove("visible");
    }, 3500);
  }

  function getStorage(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  async function loadState() {
    const data = await getStorage([
      "hearlyActive",
      "hearlyEnrolled",
      "deepgramApiKey",
      "transcriptHistory",
    ]);

    return {
      hearlyActive: data.hearlyActive || false,
      hearlyEnrolled: data.hearlyEnrolled || false,
      deepgramApiKey: data.deepgramApiKey || "",
      transcriptHistory: data.transcriptHistory || [],
    };
  }

  function syncUI() {
    mainToggle.checked = Boolean(currentState.hearlyActive);
    if (document.activeElement !== apiKeyInput) {
      apiKeyInput.value = currentState.deepgramApiKey || "";
    }
    syncModeButtons();
    updateStatus(Boolean(currentState.hearlyActive), Boolean(currentState.hearlyEnrolled));
    updateEnrollCard(Boolean(currentState.hearlyEnrolled));
    renderHistory(currentState.transcriptHistory || []);
    updateStats(currentState.transcriptHistory || []);
  }

  function updateStats(history) {
    const transcriptTotal = history.length;
    const filteredVoices = currentState.hearlyActive ? transcriptTotal : Math.min(transcriptTotal, 3);
    transcriptsCount.textContent = String(transcriptTotal);
    voicesFilteredCount.textContent = String(filteredVoices);
  }

  function syncModeButtons() {
    modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === selectedMode);
    });
  }

  function isSupportedMeetingUrl(url) {
    if (!url) return false;

    try {
      const parsed = new URL(url);
      return SUPPORTED_HOSTS.some((host) =>
        parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
      );
    } catch {
      return false;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }
});
