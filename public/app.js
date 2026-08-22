// Solstice Events Co. — Frontend Kiosk & 1-Second Polling Controller

// Base API URL (automatically adapts if running via Live Server on port 5500/etc. or Express on port 3000)
const API_BASE = (window.location.protocol.startsWith('http') && window.location.port !== '3000' && window.location.port !== '') 
  ? 'http://localhost:3000' 
  : '';

let attendees = [];
const activePollers = new Map(); // attendeeId -> intervalId

// DOM Elements
const attendeesListEl = document.getElementById('attendeesList');
const rosterCountersEl = document.getElementById('rosterCounters');
const logTerminalEl = document.getElementById('logTerminal');
const manualQrInput = document.getElementById('manualQrInput');
const btnManualScan = document.getElementById('btnManualScan');
const scanFeedbackEl = document.getElementById('scanFeedback');
const feedbackTitleEl = document.getElementById('feedbackTitle');
const feedbackMessageEl = document.getElementById('feedbackMessage');
const feedbackMetaEl = document.getElementById('feedbackMeta');
const btnResetSystem = document.getElementById('btnResetSystem');
const btnClearLogs = document.getElementById('btnClearLogs');
const pollingIndicator = document.getElementById('pollingIndicator');
const pollingText = document.getElementById('pollingText');

// Simulation Lab elements
const btnTestDuplicateScan = document.getElementById('btnTestDuplicateScan');
const toggleHardwareFailure = document.getElementById('toggleHardwareFailure');
const btnTestStaleWebhook = document.getElementById('btnTestStaleWebhook');
const btnTestForgedWebhook = document.getElementById('btnTestForgedWebhook');

/**
 * Initialize Frontend Kiosk
 */
async function init() {
  await fetchAttendees();
  setupEventListeners();
}

/**
 * Initial load of all attendees
 */
async function fetchAttendees() {
  try {
    const res = await fetch(`${API_BASE}/api/attendees`);
    const data = await res.json();
    attendees = data.attendees || [];
    renderAttendees();
    updateCounters();
    appendLog('system', 'LOADED', `Loaded ${attendees.length} conference attendees.`);
  } catch (err) {
    appendLog('system', 'ERROR', `Failed to fetch attendees: ${err.message}`);
  }
}

/**
 * Trigger Scan for an Attendee and start 1-second status polling
 * @param {string} attendeeId 
 */
async function scanAttendee(attendeeId) {
  const target = attendees.find((a) => a.id === attendeeId);
  if (!target) return;

  try {
    showFeedback('pending', 'Scan Submitted', `Queuing badge print job for ${target.name}...`);
    
    // Update local state immediately to Pending
    target.status = 'PRINT_REQUESTED';
    renderAttendees();
    updateCounters();

    const res = await fetch(`${API_BASE}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendeeId }),
    });

    const data = await res.json();

    if (res.status === 202) {
      appendLog('scan', 'SCAN ACCEPTED', `Badge print queued for ${target.name}. Polling /status/${attendeeId} every 1s...`);
      showFeedback('pending', 'Printing Badge (Pending…)', data.message, `Job ID: ${data.jobId}`);
      // Start 1-second polling loop
      startPollingAttendeeStatus(attendeeId);
    } else if (data.isDuplicate) {
      showFeedback('duplicate', 'Duplicate Scan Blocked', data.message, `Status: ${data.attendee.status}`);
      appendLog('scan', 'DUPLICATE', `Duplicate scan ignored for ${target.name}.`);
      target.status = data.attendee.status;
      renderAttendees();
      updateCounters();
    } else {
      showFeedback('error', 'Scan Error', data.error || data.message);
    }
  } catch (err) {
    showFeedback('error', 'Network Error', err.message);
    appendLog('system', 'ERROR', `Scan network error: ${err.message}`);
  }
}

/**
 * Polls GET /status/<attendee_id> every 1 second until confirmed or failed
 * @param {string} attendeeId 
 */
function startPollingAttendeeStatus(attendeeId) {
  // Clear any existing poller for this attendee
  if (activePollers.has(attendeeId)) {
    clearInterval(activePollers.get(attendeeId));
  }

  updatePollingIndicator();

  const pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/status/${attendeeId}`);
      if (!res.ok) return;

      const statusData = await res.json();
      const target = attendees.find((a) => a.id === attendeeId);
      if (!target) return;

      target.status = statusData.status;
      target.currentJobId = statusData.currentJobId;
      target.checkedInAt = statusData.checkedInAt;
      target.lastError = statusData.lastError;

      renderAttendees();
      updateCounters();

      appendLog('poll', 'POLL 1s', `GET /status/${attendeeId} ➔ ${statusData.status} (Job: ${statusData.currentJobId || 'none'})`);

      // Terminal state: Checked In confirmed!
      if (statusData.status === 'CHECKED_IN') {
        clearInterval(pollInterval);
        activePollers.delete(attendeeId);
        updatePollingIndicator();
        showFeedback('success', 'Checked In ✅', `${target.name} has been successfully checked in! Badge printed.`);
        appendLog('webhook', 'CONFIRMED', `✓ ${target.name} is now CHECKED IN!`);
      } 
      // Error state: Print failed
      else if (statusData.status === 'PRINT_FAILED') {
        clearInterval(pollInterval);
        activePollers.delete(attendeeId);
        updatePollingIndicator();
        showFeedback('error', 'Print Failed ❌', `Hardware error for ${target.name}: ${statusData.lastError ? statusData.lastError.message : 'Unknown error'}`);
        appendLog('printer', 'FAILED', `Hardware print error for ${target.name}. Retry is available.`);
      }
    } catch (err) {
      appendLog('poll', 'POLL ERROR', `Failed to poll /status/${attendeeId}: ${err.message}`);
    }
  }, 1000); // 1-second interval as requested

  activePollers.set(attendeeId, pollInterval);
  updatePollingIndicator();
}

/**
 * Retry Failed Print Job & resume polling
 */
async function retryPrint(attendeeId) {
  try {
    showFeedback('pending', 'Re-Queueing Job...', `Initiating retry print for ${attendeeId}...`);
    const target = attendees.find((a) => a.id === attendeeId);
    if (target) {
      target.status = 'PRINT_REQUESTED';
      renderAttendees();
      updateCounters();
    }

    const res = await fetch(`${API_BASE}/api/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendeeId }),
    });

    const data = await res.json();
    if (res.status === 202) {
      showFeedback('pending', 'Retry Queued (Pending…)', data.message, `New Job: ${data.jobId}`);
      appendLog('scan', 'RETRY QUEUED', `Retry print queued for ${attendeeId}. Resuming 1-second polling...`);
      startPollingAttendeeStatus(attendeeId);
    } else {
      showFeedback('error', 'Retry Failed', data.error);
    }
  } catch (err) {
    showFeedback('error', 'Network Error', err.message);
  }
}

/**
 * Render Attendees Cards in Directory with explicit "Scan" button
 */
function renderAttendees() {
  attendeesListEl.innerHTML = attendees
    .map((att) => {
      const statusClass = `status-${att.status}`;
      let statusMarkup = '';
      let actionBtn = '';

      switch (att.status) {
        case 'NOT_CHECKED_IN':
          statusMarkup = `
            <div class="status-indicator status-text-not_checked_in">
              <span class="status-bullet"></span>
              <span>Not Checked In</span>
            </div>
          `;
          actionBtn = `
            <button class="btn btn-primary btn-scan" id="btn-scan-${att.id}" onclick="scanAttendee('${att.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                <path d="M7 7h.01"></path>
                <path d="M17 7h.01"></path>
                <path d="M7 17h.01"></path>
                <path d="M17 17h.01"></path>
              </svg>
              Scan
            </button>
          `;
          break;

        case 'PRINT_REQUESTED':
          statusMarkup = `
            <div class="status-indicator status-text-pending">
              <span class="spinner-sm"></span>
              <span class="status-pending-text">Pending…</span>
            </div>
          `;
          actionBtn = `
            <button class="btn btn-secondary btn-scan" disabled>
              <span class="spinner-sm" style="width: 12px; height: 12px;"></span>
              Pending…
            </button>
          `;
          break;

        case 'CHECKED_IN':
          statusMarkup = `
            <div class="status-indicator status-text-checked_in">
              <span class="check-icon">✓</span>
              <span>Checked In ✅</span>
            </div>
          `;
          actionBtn = `
            <button class="btn btn-confirmed btn-scan" onclick="scanAttendee('${att.id}')" title="Test duplicate scan protection">
              Checked In ✅
            </button>
          `;
          break;

        case 'PRINT_FAILED':
          statusMarkup = `
            <div class="status-indicator status-text-failed">
              <span>❌</span>
              <span>Print Failed</span>
            </div>
          `;
          actionBtn = `
            <button class="btn btn-warning btn-scan" onclick="retryPrint('${att.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                <path d="M21 3v5h-5"></path>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                <path d="M3 21v-5h5"></path>
              </svg>
              Retry
            </button>
          `;
          break;
      }

      return `
        <div class="attendee-card ${statusClass}" id="card-${att.id}">
          <div class="card-top">
            <img src="${att.avatar}" alt="${att.name}" class="attendee-avatar" />
            <div class="attendee-meta">
              <div class="attendee-name">${att.name}</div>
              <div class="attendee-role">${att.title} • ${att.company}</div>
            </div>
            <span class="ticket-pill">${att.ticketType}</span>
          </div>

          <div class="card-status-badge">
            ${statusMarkup}
            <span class="job-id-tag">
              ${att.currentJobId ? att.currentJobId.split('_').slice(-2).join('_') : 'ID: ' + att.id}
            </span>
          </div>

          ${att.lastError ? `
            <div class="error-detail-box">
              ⚠ ${att.lastError.message || att.lastError}
            </div>
          ` : ''}

          <div class="card-actions">
            ${actionBtn}
          </div>
        </div>
      `;
    })
    .join('');
}

/**
 * Update Counter Pills
 */
function updateCounters() {
  const total = attendees.length;
  const checkedIn = attendees.filter((a) => a.status === 'CHECKED_IN').length;
  const pending = attendees.filter((a) => a.status === 'PRINT_REQUESTED').length;

  rosterCountersEl.innerHTML = `
    <span class="counter-badge counter-total">${total} Attendees</span>
    <span class="counter-badge counter-checkedin">${checkedIn} Checked In ✅</span>
    <span class="counter-badge counter-pending">${pending} Pending…</span>
  `;
}

function updatePollingIndicator() {
  const count = activePollers.size;
  if (count > 0) {
    pollingIndicator.classList.add('active');
    pollingText.textContent = `Polling ${count} attendee${count > 1 ? 's' : ''} (1s interval)`;
  } else {
    pollingIndicator.classList.remove('active');
    pollingText.textContent = 'Polling Idle';
  }
}

/**
 * Show feedback banner
 */
function showFeedback(type, title, message, meta = '') {
  scanFeedbackEl.className = `scan-feedback-box feedback-${type}`;
  feedbackTitleEl.textContent = title;
  feedbackMessageEl.textContent = message;
  feedbackMetaEl.textContent = meta;
  scanFeedbackEl.classList.remove('hidden');
}

/**
 * Setup UI Event Listeners
 */
function setupEventListeners() {
  btnManualScan.addEventListener('click', () => {
    const val = manualQrInput.value.trim();
    if (val) {
      // Find attendee by QR or ID
      const match = attendees.find((a) => a.qrCode === val || a.id === val);
      if (match) {
        scanAttendee(match.id);
      } else {
        showFeedback('error', 'Attendee Not Found', `No attendee matching identifier: ${val}`);
      }
    }
  });

  manualQrInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      btnManualScan.click();
    }
  });

  btnResetSystem.addEventListener('click', async () => {
    // Clear all active pollers
    for (const [id, intervalId] of activePollers.entries()) {
      clearInterval(intervalId);
    }
    activePollers.clear();
    updatePollingIndicator();

    await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
    await fetchAttendees();
    showFeedback('success', 'System Reset', 'All attendees and queues returned to initial state.');
  });

  btnClearLogs.addEventListener('click', () => {
    logTerminalEl.innerHTML = '';
  });

  // Duplicate Scan Simulation
  btnTestDuplicateScan.addEventListener('click', async () => {
    const target = attendees.find((a) => a.status === 'NOT_CHECKED_IN') || attendees[0];
    if (!target) return;

    appendLog('system', 'SIMULATION', `Triggering rapid parallel double-scan for ${target.name}...`);
    
    // Set Pending and start polling
    target.status = 'PRINT_REQUESTED';
    renderAttendees();
    startPollingAttendeeStatus(target.id);

    const [res1, res2] = await Promise.all([
      fetch(`${API_BASE}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendeeId: target.id }),
      }).then((r) => r.json()),
      fetch(`${API_BASE}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendeeId: target.id }),
      }).then((r) => r.json()),
    ]);

    if (res1.isDuplicate || res2.isDuplicate) {
      showFeedback('duplicate', 'Duplicate Scan Prevented', `1 job queued, 1 duplicate safely blocked!`);
    }
  });

  // Hardware Failure Simulation
  toggleHardwareFailure.addEventListener('change', async (e) => {
    const shouldFail = e.target.checked;
    const target = attendees[0];
    await fetch(`${API_BASE}/api/simulate/force-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendeeId: target.id, shouldFail }),
    });
    appendLog('printer', shouldFail ? 'JAM FORCED' : 'JAM CLEARED', `Hardware failure simulation ${shouldFail ? 'ENABLED' : 'DISABLED'} for ${target.name}`);
  });

  // Stale Webhook Simulation
  btnTestStaleWebhook.addEventListener('click', async () => {
    const target = attendees[0];
    const staleJobId = `job_${target.id}_expired_${Date.now() - 3600000}`;
    appendLog('system', 'INJECT STALE', `Sending stale callback with Job ID: ${staleJobId}`);
    
    const res = await fetch(`${API_BASE}/api/simulate/out-of-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendeeId: target.id, staleJobId }),
    });
    const data = await res.json();
    showFeedback('success', 'Stale Webhook Dispatched', `Response: ${JSON.stringify(data.response.data)}`);
  });

  // Tampered HMAC Webhook
  btnTestForgedWebhook.addEventListener('click', async () => {
    appendLog('security', 'SIMULATE FORGERY', 'Sending webhook with invalid HMAC signature (Expected: 401)...');
    const res = await fetch(`${API_BASE}/api/webhooks/printer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Solstice-Signature': 'sha256=invalid_tampered_signature_999',
      },
      body: JSON.stringify({
        jobId: 'job_fake_123',
        attendeeId: 'att-101',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
      }),
    });
    const data = await res.json();
    showFeedback('error', 'Security Test', `Status ${res.status}: ${data.error}`);
  });
}

/**
 * Append entry to log terminal
 */
function appendLog(category, badgeText, message) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-badge-${category}">${badgeText}</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;
  logTerminalEl.appendChild(entry);
  logTerminalEl.scrollTop = logTerminalEl.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

window.addEventListener('DOMContentLoaded', init);
