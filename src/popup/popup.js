document.addEventListener("DOMContentLoaded", async () => {
  const SUPPORTED_HOSTS = [
    "meet.google.com",
    "zoom.us",
    "teams.microsoft.com",
    "localhost",
  ];

  const mainToggle = document.getElementById("main-toggle");
  const toggleCopy = document.getElementById("toggle-copy");
  const trainingCard = document.getElementById("training-card");
  const trainingVisual = document.getElementById("training-visual");
  const trainingKicker = document.getElementById("training-kicker");
  const trainingTitle = document.getElementById("training-title");
  const trainingSubtitle = document.getElementById("training-subtitle");
  const trainedDate = document.getElementById("trained-date");
  const trainingBtn = document.getElementById("training-btn");
  const retrainLink = document.getElementById("retrain-link");
  const progressFill = document.getElementById("progress-fill");
  const phraseFeedback = document.getElementById("phrase-feedback");
  const notification = document.getElementById("notification");
  const notOnMeeting = document.getElementById("not-on-meeting");
  const micQuality = document.getElementById("mic-quality");
  const settingsToggle = document.getElementById("settings-toggle");
  const viewTranscriptsBtn = document.getElementById("view-transcripts-btn");
  const voicesFilteredCount = document.getElementById("voices-filtered-count");
  const transcriptsCount = document.getElementById("transcripts-count");
  const premiumPlanBtn = document.getElementById("premium-plan-btn");
  const premiumModal = document.getElementById("premium-modal");
  const premiumBackdrop = document.getElementById("premium-backdrop");
  const premiumCloseBtn = document.getElementById("premium-close-btn");
  const premiumEmail = document.getElementById("premium-email");
  const premiumRemindBtn = document.getElementById("premium-remind-btn");
  const premiumConfirmation = document.getElementById("premium-confirmation");
  const modeButtons = Array.from(document.querySelectorAll("[data-mode]"));

  let selectedMode = "smart";
  let onMeeting = false;
  let state = {
    hearlyActive: false,
    voiceProfile: null,
    trainedAt: "",
    transcripts: [],
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  onMeeting = isSupportedMeetingUrl(tab?.url);
  if (!onMeeting) {
    notOnMeeting.style.display = "block";
  }

  state = await loadState();
  syncUI();

  mainToggle.addEventListener("change", async () => {
    const isTrained = hasVoiceProfile(state.voiceProfile);
    if (!isTrained) {
      mainToggle.checked = false;
      showNotification("Train your voice before enabling filtering.", "error");
      return;
    }

    if (!onMeeting) {
      mainToggle.checked = false;
      showNotification("Open a supported meeting tab before enabling filtering.", "error");
      return;
    }

    const value = mainToggle.checked && selectedMode !== "off";
    await chrome.runtime.sendMessage({ type: "SET_ACTIVE", value });
    state.hearlyActive = value;
    syncUI();
    showNotification(value ? "Hearly is now filtering your mic." : "Hearly paused.", value ? "success" : "info");
  });

  trainingBtn.addEventListener("click", () => {
    startTraining().catch((err) => {
      console.error("[Hearly Popup] Training failed:", err);
      showNotification(err.message || "Could not train voice.", "error");
      renderTrainingIdle(false);
    });
  });

  retrainLink.addEventListener("click", () => {
    startTraining().catch((err) => {
      console.error("[Hearly Popup] Retraining failed:", err);
      showNotification(err.message || "Could not retrain voice.", "error");
      syncUI();
    });
  });

  settingsToggle.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  viewTranscriptsBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/history/history.html") });
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      selectedMode = button.dataset.mode || "smart";
      if (selectedMode === "off" && state.hearlyActive) {
        state.hearlyActive = false;
        mainToggle.checked = false;
        await chrome.runtime.sendMessage({ type: "SET_ACTIVE", value: false });
      }
      syncModeButtons();
      syncFilteringUI();
    });
  });

  premiumPlanBtn.addEventListener("click", openPremiumModal);
  premiumBackdrop.addEventListener("click", closePremiumModal);
  premiumCloseBtn.addEventListener("click", closePremiumModal);

  premiumRemindBtn.addEventListener("click", async () => {
    const email = premiumEmail.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      premiumConfirmation.textContent = "Enter a valid email.";
      premiumConfirmation.classList.add("error");
      return;
    }

    await chrome.storage.local.set({
      premiumEmail: email,
      signedUpAt: new Date().toISOString(),
    });
    premiumConfirmation.classList.remove("error");
    premiumConfirmation.textContent = "✓ We'll let you know!";
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes.hearlyActive) state.hearlyActive = Boolean(changes.hearlyActive.newValue);
    if (changes.voiceProfile) state.voiceProfile = changes.voiceProfile.newValue;
    if (changes.trainedAt) state.trainedAt = changes.trainedAt.newValue || "";
    if (changes.transcripts) state.transcripts = changes.transcripts.newValue || [];

    syncUI();
  });

  window.addEventListener("focus", async () => {
    state = await loadState();
    syncUI();
  });

  async function startTraining() {
    renderTrainingRecording(1);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const phraseProfiles = [];

    try {
      for (let phrase = 1; phrase <= 3; phrase += 1) {
        renderTrainingRecording(phrase);
        const phraseProfile = await recordPhrase(analyser, phrase);
        phraseProfiles.push(phraseProfile);
        progressFill.style.width = `${(phrase / 3) * 100}%`;
        phraseFeedback.textContent = `✓ Phrase ${phrase} saved`;
        await wait(650);
      }

      const profile = averageProfiles(phraseProfiles);
      const trainedAtValue = new Date().toISOString();

      await chrome.storage.local.set({
        voiceProfile: profile,
        trainedAt: trainedAtValue,
        hearlyEnrolled: true,
      });

      state.voiceProfile = profile;
      state.trainedAt = trainedAtValue;
      renderTrainingSuccess();
      await chrome.runtime.sendMessage({ type: "VOICE_ENROLLED", profile });
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      source.disconnect();
      await audioContext.close();
    }
  }

  function recordPhrase(analyser, phrase) {
    return new Promise((resolve) => {
      const freq = new Uint8Array(analyser.frequencyBinCount);
      const sums = new Float32Array(analyser.frequencyBinCount);
      let energySum = 0;
      let samples = 0;
      const startedAt = performance.now();

      const timer = setInterval(() => {
        analyser.getByteFrequencyData(freq);
        let frameEnergy = 0;
        for (let i = 0; i < freq.length; i += 1) {
          const normalized = freq[i] / 255;
          sums[i] += normalized;
          frameEnergy += normalized * normalized;
        }
        energySum += Math.sqrt(frameEnergy / freq.length);
        samples += 1;

        const elapsed = performance.now() - startedAt;
        const secondsLeft = Math.max(0, Math.ceil((3000 - elapsed) / 1000));
        trainingBtn.innerHTML = `<span class="record-dot"></span> Recording... (${phrase}/3)`;
        phraseFeedback.textContent = secondsLeft > 0 ? `Keep speaking... ${secondsLeft}s` : "Saving phrase...";

        if (elapsed >= 3000) {
          clearInterval(timer);
          const averaged = Array.from(sums, (value) => value / Math.max(samples, 1));
          resolve([energySum / Math.max(samples, 1), ...averaged]);
        }
      }, 100);
    });
  }

  function averageProfiles(profiles) {
    const length = Math.max(...profiles.map((profile) => profile.length));
    const output = new Float32Array(length);

    profiles.forEach((profile) => {
      for (let i = 0; i < length; i += 1) {
        output[i] += Number(profile[i] || 0);
      }
    });

    return Array.from(output, (value) => Number((value / profiles.length).toFixed(6)));
  }

  function renderTrainingIdle(isTrained) {
    trainingBtn.disabled = false;
    trainingCard.classList.remove("recording", "success");
    progressFill.style.width = "0%";
    phraseFeedback.textContent = "";

    if (isTrained) {
      renderTrainingSuccess();
      return;
    }

    trainingVisual.innerHTML = signalRingMarkup();
    trainingKicker.textContent = "Voice Not Trained";
    trainingTitle.textContent = "Train Your Voice";
    trainingSubtitle.textContent = "Say 3 phrases so Hearly learns your voice";
    trainedDate.hidden = true;
    trainingBtn.hidden = false;
    trainingBtn.textContent = "Start Training";
    retrainLink.hidden = true;
  }

  function renderTrainingRecording(phrase) {
    trainingCard.classList.remove("success");
    trainingCard.classList.add("recording");
    trainingVisual.innerHTML = signalRingMarkup();
    trainingKicker.textContent = "Recording";
    trainingTitle.textContent = "Train Your Voice";
    trainingSubtitle.textContent = "Speak naturally for this phrase";
    trainedDate.hidden = true;
    trainingBtn.hidden = false;
    trainingBtn.disabled = true;
    trainingBtn.innerHTML = `<span class="record-dot"></span> Recording... (${phrase}/3)`;
    retrainLink.hidden = true;
  }

  function renderTrainingSuccess() {
    trainingBtn.disabled = false;
    trainingCard.classList.remove("recording");
    trainingCard.classList.add("success");
    progressFill.style.width = "100%";
    phraseFeedback.textContent = "";
    trainingVisual.innerHTML = '<div class="trained-check">✓</div>';
    trainingKicker.textContent = "Ready";
    trainingTitle.textContent = "Voice Trained ✓";
    trainingSubtitle.textContent = "Hearly can now compare nearby speech against your voice.";
    trainedDate.hidden = false;
    trainedDate.textContent = state.trainedAt ? `Trained ${formatDate(state.trainedAt)}` : "";
    trainingBtn.hidden = true;
    retrainLink.hidden = false;
    syncFilteringUI();
  }

  function syncUI() {
    const isTrained = hasVoiceProfile(state.voiceProfile);
    renderTrainingIdle(isTrained);
    syncModeButtons();
    syncFilteringUI();
    updateStats();
  }

  function syncFilteringUI() {
    const isTrained = hasVoiceProfile(state.voiceProfile);
    const canRun = isTrained && onMeeting && selectedMode !== "off";

    mainToggle.disabled = !canRun;
    mainToggle.checked = Boolean(state.hearlyActive && canRun);
    mainToggle.closest(".pause-button")?.classList.toggle("disabled", !canRun);

    if (!isTrained) {
      micQuality.textContent = "Needs setup";
      micQuality.classList.add("needs-setup");
      toggleCopy.textContent = "Train Voice First";
    } else if (state.hearlyActive && canRun) {
      micQuality.textContent = "Active";
      micQuality.classList.remove("needs-setup");
      toggleCopy.textContent = "Pause Filtering";
    } else {
      micQuality.textContent = "Active";
      micQuality.classList.remove("needs-setup");
      toggleCopy.textContent = canRun ? "Enable Filtering" : "Meeting Required";
    }
  }

  function syncModeButtons() {
    modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === selectedMode);
    });
  }

  function updateStats() {
    const transcripts = Array.isArray(state.transcripts) ? state.transcripts : [];
    transcriptsCount.textContent = String(transcripts.length);
    voicesFilteredCount.textContent = String(transcripts.filter((item) => item.speaker === "filtered").length);
  }

  function openPremiumModal() {
    premiumModal.classList.add("open");
    premiumModal.setAttribute("aria-hidden", "false");
    premiumEmail.focus();
  }

  function closePremiumModal() {
    premiumModal.classList.remove("open");
    premiumModal.setAttribute("aria-hidden", "true");
    premiumConfirmation.textContent = "";
  }

  function showNotification(message, type = "info") {
    notification.textContent = message;
    notification.className = `notification visible ${type}`;
    setTimeout(() => {
      notification.classList.remove("visible");
    }, 3500);
  }

  async function loadState() {
    const local = await chrome.storage.local.get([
      "hearlyActive",
      "voiceProfile",
      "trainedAt",
      "transcripts",
      "transcriptHistory",
    ]);

    return {
      hearlyActive: Boolean(local.hearlyActive),
      voiceProfile: local.voiceProfile || null,
      trainedAt: local.trainedAt || local.voiceProfile?.trainedAt || "",
      transcripts: local.transcripts || migrateTranscriptHistory(local.transcriptHistory || []),
    };
  }

  function migrateTranscriptHistory(history) {
    return history.map((item) => ({
      id: crypto.randomUUID(),
      text: item.text || "",
      speaker: "nearby",
      timestamp: item.timestamp || new Date().toISOString(),
      duration: item.duration || 0,
    }));
  }

  function hasVoiceProfile(profile) {
    return Array.isArray(profile) && profile.length > 1;
  }

  function formatDate(value) {
    return new Date(value).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
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

  function signalRingMarkup() {
    return `
      <div class="signal-ring">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect x="4" y="11" width="3" height="10" rx="1.5" fill="currentColor"></rect>
          <rect x="10" y="7" width="3" height="18" rx="1.5" fill="currentColor"></rect>
          <rect x="16" y="4" width="3" height="24" rx="1.5" fill="currentColor"></rect>
          <rect x="22" y="8" width="3" height="16" rx="1.5" fill="currentColor"></rect>
        </svg>
      </div>
    `;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
});
