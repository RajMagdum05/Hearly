document.addEventListener("DOMContentLoaded", async () => {
  const closeBtn = document.getElementById("close-btn");
  const searchInput = document.getElementById("search-input");
  const bulkBar = document.getElementById("bulk-bar");
  const selectedCount = document.getElementById("selected-count");
  const deleteSelectedBtn = document.getElementById("delete-selected-btn");
  const exportSelectedBtn = document.getElementById("export-selected-btn");
  const historyList = document.getElementById("history-list");

  let transcripts = [];
  const selectedIds = new Set();

  transcripts = await loadTranscripts();
  render();

  closeBtn.addEventListener("click", () => {
    window.close();
  });

  searchInput.addEventListener("input", () => {
    render();
  });

  deleteSelectedBtn.addEventListener("click", async () => {
    if (!selectedIds.size) return;
    transcripts = transcripts.filter((item) => !selectedIds.has(item.id));
    selectedIds.clear();
    await chrome.storage.local.set({ transcripts });
    render();
  });

  exportSelectedBtn.addEventListener("click", () => {
    const selected = transcripts.filter((item) => selectedIds.has(item.id));
    exportTranscripts(selected);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.transcripts) return;
    transcripts = normalizeTranscripts(changes.transcripts.newValue || []);
    render();
  });

  async function loadTranscripts() {
    const data = await chrome.storage.local.get(["transcripts", "transcriptHistory"]);
    const normalized = normalizeTranscripts(data.transcripts || migrateTranscriptHistory(data.transcriptHistory || []));
    if (!data.transcripts && normalized.length) {
      await chrome.storage.local.set({ transcripts: normalized });
    }
    return normalized;
  }

  function render() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = transcripts
      .filter((item) => !query || item.text.toLowerCase().includes(query))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    selectedIds.forEach((id) => {
      if (!transcripts.some((item) => item.id === id)) selectedIds.delete(id);
    });

    renderBulkBar();

    if (!filtered.length) {
      historyList.innerHTML = `
        <div class="empty-state">
          <div>
            <div class="empty-icon">◌</div>
            <h2>No transcripts yet.</h2>
            <p>Hearly will show nearby voices here.</p>
          </div>
        </div>
      `;
      return;
    }

    const groups = groupByDate(filtered);
    historyList.innerHTML = Object.entries(groups).map(([label, items]) => `
      <section class="date-group">
        <div class="date-title">${escapeHtml(label)}</div>
        ${items.map(renderCard).join("")}
      </section>
    `).join("");

    historyList.querySelectorAll(".select-box").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedIds.add(checkbox.dataset.id);
        else selectedIds.delete(checkbox.dataset.id);
        renderBulkBar();
      });
    });

    historyList.querySelectorAll(".card-main").forEach((cardMain) => {
      cardMain.addEventListener("click", () => {
        cardMain.closest(".transcript-card")?.classList.toggle("expanded");
      });
    });

    historyList.querySelectorAll(".delete-button").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.id;
        transcripts = transcripts.filter((item) => item.id !== id);
        selectedIds.delete(id);
        await chrome.storage.local.set({ transcripts });
        render();
      });
    });
  }

  function renderCard(item) {
    const isSelected = selectedIds.has(item.id);
    const speakerLabel = item.speaker === "filtered" ? "🚫 Filtered" : "🔊 Nearby Voice";
    const preview = item.text.length > 120 ? `${item.text.slice(0, 120)}...` : item.text;

    return `
      <article class="transcript-card">
        <input class="select-box" type="checkbox" data-id="${escapeHtml(item.id)}" ${isSelected ? "checked" : ""} aria-label="Select transcript" />
        <div class="card-main" role="button" tabindex="0">
          <div class="card-meta">
            <span class="time">${formatTime(item.timestamp)}</span>
            <span class="badge ${item.speaker === "filtered" ? "filtered" : ""}">${speakerLabel}</span>
            <span class="badge duration">${Math.max(0, Math.round(item.duration || 0))}s</span>
          </div>
          <p class="preview">${escapeHtml(preview)}</p>
          <p class="full-text">${escapeHtml(item.text)}</p>
        </div>
        <button class="delete-button" type="button" data-id="${escapeHtml(item.id)}" aria-label="Delete transcript">🗑 Delete</button>
      </article>
    `;
  }

  function renderBulkBar() {
    bulkBar.hidden = selectedIds.size === 0;
    selectedCount.textContent = `${selectedIds.size} selected`;
  }

  function groupByDate(items) {
    return items.reduce((groups, item) => {
      const label = formatDateGroup(item.timestamp);
      groups[label] ||= [];
      groups[label].push(item);
      return groups;
    }, {});
  }

  function exportTranscripts(items) {
    if (!items.length) return;

    const text = items
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .map((item) => {
        const stamp = new Date(item.timestamp).toLocaleString();
        const speaker = item.speaker === "filtered" ? "FILTERED" : "NEARBY";
        return `[${stamp}] — ${speaker}\n${item.text}\n────────────────`;
      })
      .join("\n\n");

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hearly-transcripts-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function normalizeTranscripts(items) {
    return items.map((item) => ({
      id: item.id || crypto.randomUUID(),
      text: String(item.text || ""),
      speaker: item.speaker === "filtered" ? "filtered" : "nearby",
      timestamp: item.timestamp || new Date().toISOString(),
      duration: Number(item.duration || 0),
    })).filter((item) => item.text.trim());
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

  function formatDateGroup(value) {
    const date = new Date(value);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (isSameDay(date, today)) return "TODAY";
    if (isSameDay(date, yesterday)) return "YESTERDAY";

    return date.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
});
