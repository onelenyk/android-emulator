'use strict';

let emulators = [];
let selectedId = null;
let pollTimer = null;

const $ = (id) => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────
const listEl      = $('emulator-list');
const countEl     = $('count');
const mainTitle   = $('main-title');
const adbCmdEl    = $('adb-cmd');
const adbText     = $('adb-text');
const copyBtn     = $('copy-btn');
const vncFrame    = $('vnc-frame');
const placeholder = $('placeholder');
const modalOverlay = $('modal-overlay');
const versionSel  = $('version-select');
const modalError  = $('modal-error');
const confirmBtn  = $('confirm-btn');

// ── Fetch available versions (once) ──────────────────────────
async function loadVersions() {
  const res = await fetch('/api/versions');
  const versions = await res.json();
  versionSel.innerHTML = versions
    .map((v) => `<option value="${v.api}">${v.name}</option>`)
    .join('');
}

// ── Polling ───────────────────────────────────────────────────
async function poll() {
  try {
    const res = await fetch('/api/emulators');
    if (!res.ok) return;
    emulators = await res.json();
    renderList();
  } catch (_) { /* network error — keep previous state */ }
}

function startPolling() {
  poll();
  pollTimer = setInterval(poll, 3000);
}

// ── Render sidebar list ───────────────────────────────────────
function renderList() {
  countEl.textContent = emulators.length;

  if (emulators.length === 0) {
    listEl.innerHTML = '<div class="empty-list">No emulators running</div>';
    if (selectedId) clearSelection();
    return;
  }

  const ids = new Set(emulators.map((e) => e.id));
  if (selectedId && !ids.has(selectedId)) clearSelection();

  listEl.innerHTML = emulators.map((e) => `
    <div class="emulator-item${e.id === selectedId ? ' active' : ''}"
         data-id="${e.id}" role="button" tabindex="0">
      <div class="emulator-item-left">
        <span class="status-dot ${e.status}"></span>
        <span class="emulator-name" title="${e.name}">${e.name}</span>
      </div>
      <button class="stop-btn" data-id="${e.id}" title="Stop">&#9632;</button>
    </div>
  `).join('');

  listEl.querySelectorAll('.emulator-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.stop-btn')) return;
      selectEmulator(el.dataset.id);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') selectEmulator(el.dataset.id);
    });
  });

  listEl.querySelectorAll('.stop-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      stopEmulator(btn.dataset.id);
    });
  });
}

// ── Select emulator ───────────────────────────────────────────
function selectEmulator(id) {
  const emulator = emulators.find((e) => e.id === id);
  if (!emulator) return;

  selectedId = id;

  mainTitle.textContent = emulator.name;
  adbText.textContent   = emulator.adbCmd;
  adbCmdEl.style.display = 'flex';

  placeholder.style.display = 'none';
  vncFrame.style.display    = 'block';

  // Only reload iframe if URL changed
  if (vncFrame.src !== emulator.vncUrl) {
    vncFrame.src = emulator.vncUrl;
  }

  renderList(); // refresh active state
}

function clearSelection() {
  selectedId = null;
  mainTitle.textContent = 'Select an emulator';
  adbCmdEl.style.display = 'none';
  vncFrame.style.display = 'none';
  vncFrame.src = '';
  placeholder.style.display = 'flex';
}

// ── Stop emulator ─────────────────────────────────────────────
async function stopEmulator(id) {
  try {
    await fetch(`/api/emulators/${id}`, { method: 'DELETE' });
    if (selectedId === id) clearSelection();
    await poll();
  } catch (err) {
    alert(`Failed to stop emulator: ${err.message}`);
  }
}

// ── Copy ADB command ──────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(adbText.textContent).then(() => {
    copyBtn.style.color = '#22c55e';
    setTimeout(() => { copyBtn.style.color = ''; }, 1200);
  });
});

// ── Launch modal ──────────────────────────────────────────────
$('launch-btn').addEventListener('click', () => {
  modalError.textContent = '';
  confirmBtn.disabled = false;
  modalOverlay.classList.remove('hidden');
});

$('cancel-btn').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

function closeModal() {
  modalOverlay.classList.add('hidden');
  modalError.textContent = '';
  confirmBtn.disabled = false;
}

confirmBtn.addEventListener('click', async () => {
  const androidVersion = versionSel.value;
  confirmBtn.disabled = true;
  modalError.textContent = '';

  try {
    const res = await fetch('/api/emulators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ androidVersion }),
    });

    const data = await res.json();

    if (!res.ok) {
      modalError.textContent = data.error || 'Failed to launch emulator';
      confirmBtn.disabled = false;
      return;
    }

    closeModal();
    await poll();
    selectEmulator(data.id);
  } catch (err) {
    modalError.textContent = err.message;
    confirmBtn.disabled = false;
  }
});

// ── Boot ──────────────────────────────────────────────────────
loadVersions();
startPolling();
