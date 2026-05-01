// ─────────────────────────────────────────────
//  Hearly — Popup Script
// ─────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {

  // ── Elements ──────────────────────────────
  const mainToggle     = document.getElementById("main-toggle");
  const statusDot      = document.getElementById("status-dot");
  const statusLabel    = document.getElementById("status-label");
  const statusSublabel = document.getElementById("status-sublabel");
  const enrollBtn      = document.getElementById("enroll-btn");
  const enrollCard     = document.getElementById("enroll-card");
  const enrollTitle    = document.getElementById("enroll-title");
  const enrollDesc     = document.getElementById("enroll-desc");
  const recIndicator   = document.getElementById("rec-indicator");
  const recTimer       = document.getElementById("rec-timer");
  const apiKeyInput    = document.getElementById("api-key-input");
  const saveKeyBtn     = document.getElementById("save-key-btn");
  const showKeyBtn     = document.getElementById("show-key-btn");
  const resetBtn       = document.getElementById("reset-btn");
  const notification   = document.getElementById("notification");
  const historyContent = document.getElementById("history-content");
  const notOnMeeting   = document.getElementById("not-on-meeting");
  const statusCard     = document.getElementById("status-card");

  // ── Load stored state ─────────────────────
  const data = await getStorage([
    "hearlyActive",
    "hearlyEnrolled",
    "deepgramApiKey",
    "transcriptHistory",
  ]);

  const isActive   = data.hearlyActive   || false;
  const isEnrolled = data.hearlyEnrolled || false;
  const apiKey     = data.deepgramApiKey || "";
  const history    = data.transcriptHistory || [];

  mainToggle.checked = isActive;
  apiKeyInput.value  = apiKey;

  // ── Check if on meeting page ───────────────
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onMeeting = tab?.url &&
    (tab.url.includes("meet.google.com") ||
     tab.url.includes("zoom.us") ||
     tab.url.includes("teams.microsoft.com"));

  if (!onMeeting) {
    notOnMeeting.style.display = "block";
    mainToggle.disabled = true;
    statusCard.style.opacity = "0.5";
  }

  updateStatus(isActive, isEnrolled);
  updateEnrollCard(isEnrolled);
  renderHistory(history);

  // ── Toggle Hearly on/off ───────────────────
  mainToggle.addEventListener("change", async () => {
    const value = mainToggle.checked;
    await chrome.runtime.sendMessage({ type: "SET_ACTIVE", value });
    updateStatus(value, isEnrolled);
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
      if (err.message.includes("Cannot access")) {
        showNotification("❌ Hearly cannot access this page. Please try on Google Meet or Zoom.", "error");
      } else {
        showNotification("❌ Could not start training. Check permissions.", "error");
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
    showNotification("🔑 API key saved!", "success");
  });

  // ── Show/hide API key ──────────────────────
  showKeyBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    showKeyBtn.textContent = apiKeyInput.type === "password" ? "Show" : "Hide";
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

  // ── Refresh history every 2 seconds ───────
  setInterval(async () => {
    const d = await getStorage(["transcriptHistory"]);
    renderHistory(d.transcriptHistory || []);
  }, 2000);

  // ═══════════════════════════════════════════
  //  HELPER FUNCTIONS
  // ═══════════════════════════════════════════

  function updateStatus(active, enrolled) {
    if (!enrolled) {
      statusDot.className = "status-dot not-enrolled";
      statusLabel.textContent = "Voice not trained";
      statusSublabel.textContent = "Enroll your voice first";
      mainToggle.disabled = true;
    } else if (active) {
      statusDot.className = "status-dot active";
      statusLabel.textContent = "Filtering Active";
      statusSublabel.textContent = "Background voices are being muted";
      mainToggle.disabled = false;
    } else {
      statusDot.className = "status-dot inactive";
      statusLabel.textContent = "Hearly Off";
      statusSublabel.textContent = "Toggle to start filtering";
      mainToggle.disabled = false;
    }
  }

  function updateEnrollCard(enrolled) {
    if (enrolled) {
      enrollCard.classList.add("enrolled");
      enrollTitle.textContent = "✅ Voice enrolled";
      enrollDesc.textContent = "Hearly knows your voice. Re-train anytime.";
      enrollBtn.textContent = "🔄 Re-train Voice";
      enrollBtn.className = "btn btn-secondary";
    } else {
      enrollCard.classList.remove("enrolled");
      enrollTitle.textContent = "Not enrolled yet";
      enrollDesc.textContent = "Train Hearly to recognize your voice (5 seconds)";
      enrollBtn.innerHTML = "<span>🎙</span> Train My Voice";
      enrollBtn.className = "btn btn-primary";
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

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }
});
