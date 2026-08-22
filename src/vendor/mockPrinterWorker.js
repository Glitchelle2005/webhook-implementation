const http = require('http');
const { computeSignature } = require('../services/webhookValidator');
const { EventEmitter } = require('events');

class MockPrinterVendorWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.webhookUrl = options.webhookUrl || 'http://127.0.0.1:3000/api/webhooks/printer';
    this.printDelayMs = options.printDelayMs !== undefined ? options.printDelayMs : 800;
    this.forcedFailures = new Set(); // Set of attendeeIds to fail
    this.forcedDelays = new Map(); // attendeeId -> delayMs
    this.processedJobs = [];
    this.inFlightJobs = new Map();
  }

  /**
   * Connects worker to the queue and listens for print jobs.
   */
  start(queue) {
    this.queue = queue;
    this.queue.subscribe('badge-print-jobs', async (payload, job) => {
      await this.handlePrintJob(payload, job);
    });
    this.emit('started', { webhookUrl: this.webhookUrl });
  }

  /**
   * Simulates badge printing hardware execution and invokes webhook.
   */
  async handlePrintJob(payload, job) {
    const { jobId, attendeeId, attendeeName, ticketType, company } = payload;
    const startTime = Date.now();

    this.inFlightJobs.set(jobId, { jobId, attendeeId, attendeeName, startedAt: startTime });
    this.emit('print:started', { jobId, attendeeId, attendeeName, ticketType, company });

    // Determine processing delay
    const delay = this.forcedDelays.get(attendeeId) || this.printDelayMs;
    await new Promise((r) => setTimeout(r, delay));

    // Determine outcome
    const shouldFail = this.forcedFailures.has(attendeeId) || payload.forceFail === true;
    const status = shouldFail ? 'FAILED' : 'SUCCESS';
    const errorDetails = shouldFail
      ? {
          errorCode: 'HARDWARE_PAPER_JAM',
          message: 'Thermal printer sensor error: paper feed jam or empty ribbon tray.',
          vendorHardwareId: 'PRN-BAY-04-THERMAL',
        }
      : null;

    const webhookPayload = {
      jobId,
      attendeeId,
      status,
      timestamp: new Date().toISOString(),
      printerDetails: {
        printerId: 'SOLSTICE-THERMAL-PRN-01',
        firmware: 'v4.8.2-fastprint',
        printedBadgeFormat: ticketType || 'Standard Attendee',
      },
      errorDetails,
    };

    const signature = computeSignature(webhookPayload);

    this.inFlightJobs.delete(jobId);
    this.processedJobs.push({
      jobId,
      attendeeId,
      status,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    });

    this.emit('print:finished', { jobId, attendeeId, status, payload: webhookPayload });

    // Dispatch webhook to kiosk service
    await this.dispatchWebhook(webhookPayload, signature);
  }

  /**
   * Sends the HMAC-signed webhook HTTP POST request.
   */
  async dispatchWebhook(payload, signature, targetUrl = this.webhookUrl) {
    const urlObj = new URL(targetUrl);
    const bodyStr = JSON.stringify(payload);

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || 3000,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            'X-Solstice-Signature': signature,
            'User-Agent': 'Solstice-Badge-Vendor-Printer-Service/1.0',
          },
        },
        (res) => {
          let responseData = '';
          res.on('data', (chunk) => (responseData += chunk));
          res.on('end', () => {
            this.emit('webhook:delivered', {
              jobId: payload.jobId,
              statusCode: res.statusCode,
              response: responseData,
            });
            resolve({ statusCode: res.statusCode, data: responseData });
          });
        }
      );

      req.on('error', (err) => {
        this.emit('webhook:error', { jobId: payload.jobId, error: err.message });
        resolve({ statusCode: 0, error: err.message });
      });

      req.write(bodyStr);
      req.end();
    });
  }

  // Simulation helpers for testing
  forceFailure(attendeeId, shouldFail = true) {
    if (shouldFail) {
      this.forcedFailures.add(attendeeId);
    } else {
      this.forcedFailures.delete(attendeeId);
    }
  }

  setDelay(ms) {
    this.printDelayMs = ms;
  }

  clearSimulationOverrides() {
    this.forcedFailures.clear();
    this.forcedDelays.clear();
    this.processedJobs = [];
    this.inFlightJobs.clear();
  }
}

const mockPrinterWorker = new MockPrinterVendorWorker();

module.exports = {
  MockPrinterVendorWorker,
  mockPrinterWorker,
};
