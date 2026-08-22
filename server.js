const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');

const { AttendeeState } = require('./src/models/attendee');
const { attendeeStore } = require('./src/store/attendeeStore');
const { defaultQueue } = require('./src/queue/queueAdapter');
const { mockPrinterWorker } = require('./src/vendor/mockPrinterWorker');
const { verifySignature, validateWebhookPayload } = require('./src/services/webhookValidator');

const app = express();
const PORT = process.env.PORT || 3000;

// SSE connected clients
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Attach event listeners to queue and worker for live UI audit stream
defaultQueue.on('job:enqueued', (event) => broadcastEvent('queue:enqueued', event));
defaultQueue.on('job:processing', (event) => broadcastEvent('queue:processing', event));
defaultQueue.on('job:completed', (event) => broadcastEvent('queue:completed', event));

mockPrinterWorker.on('print:started', (event) => broadcastEvent('printer:started', event));
mockPrinterWorker.on('print:finished', (event) => broadcastEvent('printer:finished', event));
mockPrinterWorker.on('webhook:delivered', (event) => broadcastEvent('webhook:delivered', event));

// Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Solstice-Signature');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // Also serve root directory if needed
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// ==========================================
// API ROUTES
// ==========================================

/**
 * GET /api/attendees
 * Returns list of all attendees and their state machine statuses.
 */
app.get('/api/attendees', (req, res) => {
  res.json({ attendees: attendeeStore.getAll() });
});

/**
 * GET /api/attendees/:id
 */
app.get('/api/attendees/:id', (req, res) => {
  const attendee = attendeeStore.get(req.params.id);
  if (!attendee) {
    return res.status(404).json({ error: 'Attendee not found' });
  }
  res.json({ attendee });
});

/**
 * GET /status/:attendee_id
 * Dedicated polling endpoint: returns attendee status, job ID, and details.
 */
app.get('/status/:attendee_id', (req, res) => {
  const attendee = attendeeStore.get(req.params.attendee_id);
  if (!attendee) {
    return res.status(404).json({ error: 'Attendee not found' });
  }
  res.json({
    attendeeId: attendee.id,
    name: attendee.name,
    status: attendee.status,
    currentJobId: attendee.currentJobId,
    checkedInAt: attendee.checkedInAt,
    lastError: attendee.lastError,
  });
});

app.get('/api/status/:attendee_id', (req, res) => {
  res.redirect(`/status/${req.params.attendee_id}`);
});

/**
 * POST /api/scan
 * Core Scan Handler: Scans attendee QR or ID and initiates async badge printing.
 * Concurrency-safe: atomically prevents duplicate print jobs.
 */
app.post('/api/scan', async (req, res) => {
  const { attendeeId, qrCode } = req.body;

  let attendee = null;
  if (attendeeId) {
    attendee = attendeeStore.get(attendeeId);
  } else if (qrCode) {
    attendee = attendeeStore.findByQrCode(qrCode);
  }

  if (!attendee) {
    return res.status(404).json({
      success: false,
      error: 'Attendee not found for provided identifier',
    });
  }

  // Generate unique request UUID / Idempotency Key for this print job
  const jobId = `job_${attendee.id}_${crypto.randomUUID().split('-')[0]}_${Date.now()}`;

  // Atomic Compare-And-Set state check
  const casResult = await attendeeStore.requestPrint(attendee.id, jobId);

  if (!casResult.success) {
    // Duplicate scan protection or invalid transition
    broadcastEvent('scan:duplicate_blocked', {
      attendeeId: attendee.id,
      reason: casResult.reason,
      message: casResult.message,
      currentStatus: casResult.attendee.status,
    });

    return res.status(casResult.isDuplicate ? 200 : 400).json({
      success: false,
      isDuplicate: casResult.isDuplicate || false,
      reason: casResult.reason,
      message: casResult.message,
      attendee: casResult.attendee,
    });
  }

  // Publish job to async message queue (app does NOT wait for vendor response)
  const jobPayload = {
    jobId,
    attendeeId: attendee.id,
    attendeeName: attendee.name,
    company: attendee.company,
    ticketType: attendee.ticketType,
    requestedAt: new Date().toISOString(),
  };

  await defaultQueue.publish('badge-print-jobs', jobPayload);

  broadcastEvent('attendee:updated', {
    attendee: casResult.attendee,
    action: 'PRINT_REQUESTED',
    jobId,
  });

  // Immediately return Pending state
  return res.status(202).json({
    success: true,
    status: AttendeeState.PRINT_REQUESTED,
    message: `Badge print job queued for ${attendee.name}. Current status is Pending.`,
    jobId,
    attendee: casResult.attendee,
  });
});

/**
 * POST /api/retry
 * Retry Handler: Re-queues badge printing for attendees in PRINT_FAILED state.
 */
app.post('/api/retry', async (req, res) => {
  const { attendeeId } = req.body;
  const attendee = attendeeStore.get(attendeeId);

  if (!attendee) {
    return res.status(404).json({ error: 'Attendee not found' });
  }

  if (attendee.status !== AttendeeState.PRINT_FAILED) {
    return res.status(400).json({
      error: `Cannot retry attendee in status "${attendee.status}". Retry is only permitted for PRINT_FAILED.`,
    });
  }

  // Generate a brand new jobId (which invalidates any late-arriving callbacks from the old jobId)
  const newJobId = `job_${attendee.id}_retry_${crypto.randomUUID().split('-')[0]}_${Date.now()}`;

  const casResult = await attendeeStore.requestPrint(attendee.id, newJobId);
  if (!casResult.success) {
    return res.status(400).json({ error: casResult.message });
  }

  // Enqueue new job
  await defaultQueue.publish('badge-print-jobs', {
    jobId: newJobId,
    attendeeId: attendee.id,
    attendeeName: attendee.name,
    company: attendee.company,
    ticketType: attendee.ticketType,
    isRetry: true,
  });

  broadcastEvent('attendee:updated', {
    attendee: casResult.attendee,
    action: 'RETRY_REQUESTED',
    jobId: newJobId,
  });

  return res.status(202).json({
    success: true,
    status: AttendeeState.PRINT_REQUESTED,
    message: `Retry print job queued for ${attendee.name}.`,
    jobId: newJobId,
    attendee: casResult.attendee,
  });
});

/**
 * POST /api/webhooks/printer
 * Webhook Receiver: Handles asynchronous callback from the badge printer vendor.
 * Validates HMAC signature, payload schema, and ensures idempotency + out-of-order protection.
 */
app.post('/api/webhooks/printer', async (req, res) => {
  const signatureHeader = req.headers['x-solstice-signature'];
  const payload = req.body;

  // 1. Authenticate webhook using HMAC-SHA256 signature
  const isValidSignature = verifySignature(req.rawBody || payload, signatureHeader) || verifySignature(payload, signatureHeader);
  if (!isValidSignature) {
    broadcastEvent('security:unauthorized_webhook', {
      error: 'Invalid or missing HMAC signature header (X-Solstice-Signature)',
      payload,
    });
    return res.status(401).json({
      error: 'Unauthorized: Invalid HMAC signature.',
    });
  }

  // 2. Validate payload contract
  const validation = validateWebhookPayload(payload);
  if (!validation.valid) {
    return res.status(400).json({
      error: `Bad Request: ${validation.error}`,
    });
  }

  const { attendeeId, jobId, status, errorDetails } = payload;

  // 3. Process state machine transition with idempotency & superseded job checks
  const result = await attendeeStore.completePrint(attendeeId, jobId, status, errorDetails);

  if (!result.success && !result.ignored) {
    return res.status(400).json({
      error: result.message || 'Failed to process webhook',
      reason: result.reason,
    });
  }

  // 4. Broadcast real-time update
  broadcastEvent('webhook:processed', {
    attendeeId,
    jobId,
    status,
    resultStatus: result.attendee ? result.attendee.status : null,
    ignored: result.ignored || false,
    reason: result.reason,
    message: result.message,
  });

  if (result.attendee) {
    broadcastEvent('attendee:updated', {
      attendee: result.attendee,
      action: status === 'SUCCESS' ? 'CHECKED_IN' : 'PRINT_FAILED',
      jobId,
    });
  }

  return res.status(200).json({
    received: true,
    jobId,
    status: result.attendee ? result.attendee.status : 'UNKNOWN',
    ignored: result.ignored || false,
    reason: result.reason,
    message: result.message || 'Webhook successfully processed',
  });
});

/**
 * GET /api/events
 * Real-time SSE stream for the Kiosk UI
 */
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to Solstice Event Stream' })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

/**
 * POST /api/simulate/out-of-order
 * Test Endpoint: Simulates an older/stale webhook arriving after a newer job
 */
app.post('/api/simulate/out-of-order', async (req, res) => {
  const { attendeeId, staleJobId, status } = req.body;
  const webhookPayload = {
    jobId: staleJobId || `job_${attendeeId}_stale_${Date.now()}`,
    attendeeId,
    status: status || 'SUCCESS',
    timestamp: new Date(Date.now() - 60000).toISOString(),
    printerDetails: { simulated: true, type: 'STALE_OUT_OF_ORDER' },
  };

  const { computeSignature } = require('./src/services/webhookValidator');
  const signature = computeSignature(webhookPayload);

  const response = await mockPrinterWorker.dispatchWebhook(webhookPayload, signature);
  res.json({ simulated: true, payload: webhookPayload, response });
});

/**
 * POST /api/simulate/force-failure
 * Test Endpoint: Forces hardware failure simulation for an attendee
 */
app.post('/api/simulate/force-failure', (req, res) => {
  const { attendeeId, shouldFail } = req.body;
  mockPrinterWorker.forceFailure(attendeeId, shouldFail !== false);
  res.json({ attendeeId, forceFail: shouldFail !== false });
});

/**
 * POST /api/reset
 * Resets state store and simulation overrides for testing
 */
app.post('/api/reset', (req, res) => {
  attendeeStore.reset();
  defaultQueue.clear();
  mockPrinterWorker.clearSimulationOverrides();
  broadcastEvent('system:reset', { message: 'System state reset to initial' });
  res.json({ success: true, message: 'Kiosk service reset successfully' });
});

// Start vendor printer background worker
mockPrinterWorker.start(defaultQueue);

let serverInstance = null;
function startServer(port = PORT) {
  return new Promise((resolve) => {
    serverInstance = app.listen(port, () => {
      console.log(`[Solstice Kiosk] Service listening on port ${port}`);
      resolve(serverInstance);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  attendeeStore,
  defaultQueue,
  mockPrinterWorker,
};
