'use strict';

let emulators = [];
let selectedId = null;
let pollTimer = null;
let currentES = null;
const bootState = new Map();

const $ = (id) => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────
const listEl       = $('emulator-list');
const countEl      = $('count');
const mainTitle    = $('main-title');
const adbCmdEl     = $('adb-cmd');
const adbText      = $('adb-text');
const copyBtn      = $('copy-btn');
const vncFrame     = $('vnc-frame');
const placeholder  = $('placeholder');
const modalOverlay = $('modal-overlay');
const versionSel   = $('version-select');
const deviceSel    = $('device-select');
const cancelBtn    = $('cancel-btn');
const modalError   = $('modal-error');
const confirmBtn   = $('confirm-btn');
const stopAllBtn   = $('stop-all-btn');
const pullProgress = $('pull-progress');
const pullPhase    = $('pull-phase');
const pullLayers   = $('pull-layers');

// ── Helpers ───────────────────────────────────────────────────
function fmtBytes(n) {
  if (!n) return '';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// ── Load versions & devices ───────────────────────────────────
async function loadVersions() {
  const res = await fetch('/api/versions');
  const versions = await res.json();
  versionSel.innerHTML = versions
    .map((v) => `<option value="${v.api}">${v.name}</option>`)
    .join('');
}

async function loadDevices() {
  const res = await fetch('/api/devices');
  const devices = await res.json();
  deviceSel.innerHTML = devices
    .map((d) => `<option value="${d}">${d}</option>`)
    .join('');
}

// ── Polling ───────────────────────────────────────────────────
async function poll() {
  try {
    const res = await fetch('/api/emulators');
    if (!res.ok) return;
    emulators = await res.json();
    renderList();

    // Prune stale boot entries
    const ids = new Set(emulators.map((e) => e.id));
    for (const id of bootState.keys()) {
      if (!ids.has(id)) bootState.delete(id);
    }

    // Background boot-status checks (skip already-booted containers)
    emulators.filter((e) => e.status === 'running' && bootState.get(e.id) !== 'booted').forEach((e) => {
      fetch(`/api/emulators/${e.id}/status`)
        .then((r) => r.json())
        .then(({ status }) => { bootState.set(e.id, status); renderList(); })
        .catch(() => {});
    });
  } catch (_) { /* network error — keep previous state */ }
}

function startPolling() {
  poll();
  pollTimer = setInterval(poll, 3000);
}

// ── Render sidebar list ───────────────────────────────────────
function renderList() {
  countEl.textContent = emulators.length;
  stopAllBtn.disabled = emulators.length === 0;

  if (emulators.length === 0) {
    listEl.innerHTML = '<div class="empty-list">No emulators running</div>';
    if (selectedId) clearSelection();
    return;
  }

  const ids = new Set(emulators.map((e) => e.id));
  if (selectedId && !ids.has(selectedId)) clearSelection();

  listEl.innerHTML = emulators.map((e) => {
    const boot = bootState.get(e.id);
    const dotClass = e.status === 'running'
      ? (boot === 'booted' ? 'running' : 'booting')
      : e.status;

    const buttons = e.status === 'running'
      ? `<button class="stop-btn" data-id="${e.id}" title="Stop">&#9632;</button>`
      : `<button class="start-btn" data-id="${e.id}" title="Restart">&#9654;</button>
         <button class="stop-btn" data-id="${e.id}" title="Remove">&#9632;</button>`;

    return `
      <div class="emulator-item${e.id === selectedId ? ' active' : ''}"
           data-id="${e.id}" role="button" tabindex="0">
        <div class="emulator-item-left">
          <span class="status-dot ${dotClass}"></span>
          <span class="emulator-name" title="${e.name}">${e.name}</span>
        </div>
        <div class="item-actions">${buttons}</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.emulator-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.stop-btn') || ev.target.closest('.start-btn')) return;
      selectEmulator(el.dataset.id);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') selectEmulator(el.dataset.id);
    });
  });

  listEl.querySelectorAll('.stop-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); stopEmulator(btn.dataset.id); });
  });

  listEl.querySelectorAll('.start-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); restartEmulator(btn.dataset.id); });
  });
}

// ── Select / clear emulator ───────────────────────────────────
function selectEmulator(id) {
  const emulator = emulators.find((e) => e.id === id);
  if (!emulator) return;

  selectedId = id;
  mainTitle.textContent  = emulator.name;
  adbText.textContent    = emulator.adbCmd;
  adbCmdEl.style.display = 'flex';
  placeholder.style.display = 'none';
  vncFrame.style.display    = 'block';

  if (vncFrame.src !== emulator.vncUrl) vncFrame.src = emulator.vncUrl;
  renderList();
}

function clearSelection() {
  selectedId = null;
  mainTitle.textContent  = 'Select an emulator';
  adbCmdEl.style.display = 'none';
  vncFrame.style.display = 'none';
  vncFrame.src = '';
  placeholder.style.display = 'flex';
}

// ── Stop / restart emulators ──────────────────────────────────
async function stopEmulator(id) {
  try {
    await fetch(`/api/emulators/${id}`, { method: 'DELETE' });
    if (selectedId === id) clearSelection();
    await poll();
  } catch (err) {
    alert(`Failed to stop emulator: ${err.message}`);
  }
}

async function restartEmulator(id) {
  try {
    await fetch(`/api/emulators/${id}/start`, { method: 'POST' });
    await poll();
  } catch (err) {
    alert(`Failed to restart emulator: ${err.message}`);
  }
}

// ── Stop All ──────────────────────────────────────────────────
stopAllBtn.addEventListener('click', async () => {
  stopAllBtn.disabled = true;
  try {
    await Promise.all(emulators.map((e) => fetch(`/api/emulators/${e.id}`, { method: 'DELETE' })));
    clearSelection();
    await poll();
  } finally {
    stopAllBtn.disabled = emulators.length === 0;
  }
});

// ── Copy ADB command ──────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(adbText.textContent).then(() => {
    copyBtn.style.color = '#22c55e';
    setTimeout(() => { copyBtn.style.color = ''; }, 1200);
  });
});

// ── Modal helpers ─────────────────────────────────────────────
function closeModal() {
  if (currentES) { currentES.close(); currentES = null; }
  modalOverlay.classList.add('hidden');
  modalError.textContent = '';
  confirmBtn.disabled = false;
  cancelBtn.disabled = false;
  pullProgress.style.display = 'none';
  pullPhase.textContent = 'Pulling image...';
  pullLayers.innerHTML = '';
}

$('launch-btn').addEventListener('click', () => {
  closeModal();
  modalOverlay.classList.remove('hidden');
});

cancelBtn.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ── Launch emulator (with SSE progress) ──────────────────────
confirmBtn.addEventListener('click', async () => {
  const androidVersion = versionSel.value;
  const device = deviceSel.value;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  modalError.textContent = '';

  try {
    const res = await fetch('/api/emulators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ androidVersion, device }),
    });

    const data = await res.json();

    if (!res.ok) {
      modalError.textContent = data.error || 'Failed to launch emulator';
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      return;
    }

    // Switch modal to progress view
    pullProgress.style.display = 'block';
    pullPhase.textContent = 'Pulling image...';
    const layerMap = new Map();

    currentES = new EventSource(`/api/emulators/launch-progress/${data.jobId}`);

    currentES.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.phase === 'pulling' && msg.id) {
        let row = layerMap.get(msg.id);
        if (!row) {
          row = document.createElement('div');
          row.className = 'pull-layer';
          pullLayers.appendChild(row);
          layerMap.set(msg.id, row);
          pullLayers.scrollTop = pullLayers.scrollHeight;
        }
        const pd = msg.progressDetail || {};
        const prog = pd.total ? ` ${fmtBytes(pd.current)}/${fmtBytes(pd.total)}` : '';
        row.innerHTML =
          `<span class="pull-layer-id">${msg.id.slice(0, 12)}</span>` +
          `<span class="pull-layer-status">${msg.status}</span>` +
          `<span class="pull-layer-prog">${prog}</span>`;
      } else if (msg.phase === 'starting') {
        pullPhase.textContent = 'Starting container...';
      } else if (msg.phase === 'done') {
        currentES.close(); currentES = null;
        const cId = msg.containerId;
        closeModal();
        poll().then(() => selectEmulator(cId));
      } else if (msg.phase === 'error') {
        currentES.close(); currentES = null;
        modalError.textContent = msg.message || 'Launch failed';
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        pullProgress.style.display = 'none';
      }
    };

    currentES.onerror = () => {
      currentES.close(); currentES = null;
      modalError.textContent = 'Connection lost during launch';
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      pullProgress.style.display = 'none';
    };

  } catch (err) {
    modalError.textContent = err.message;
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    pullProgress.style.display = 'none';
  }
});

// ── Boot ──────────────────────────────────────────────────────
loadVersions();
loadDevices();
startPolling();
