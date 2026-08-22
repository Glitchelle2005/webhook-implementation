const assert = require('assert');
const http = require('http');
const { AttendeeState } = require('../src/models/attendee');
const { computeSignature } = require('../src/services/webhookValidator');
const { mockPrinterWorker } = require('../src/vendor/mockPrinterWorker');

// Helper to make HTTP JSON requests
function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'Content-Type': 'application/json',
    };
    const reqOptions = {
      hostname: '127.0.0.1',
      port: 3000,
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) },
    };

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = body ? JSON.parse(body) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });

    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log('  SOLSTICE EVENTS CO. — ASYNC KIOSK TEST SUITE');
  console.log('======================================================\n');

  // Fast test mode print delay
  mockPrinterWorker.setDelay(80);

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`• Running: ${name} ... `);
    try {
      // Reset server state before each test
      await request({ method: 'POST', path: '/api/reset' });
      await fn();
      console.log('✅ PASS');
      passed++;
    } catch (err) {
      console.log('❌ FAIL');
      console.error('  Error:', err.message);
      if (err.stack) {
        console.error('  ', err.stack.split('\n').slice(1, 4).join('\n  '));
      }
      failed++;
    }
  }

  // -----------------------------------------------------------------
  // SCENARIO 1: 3+ Attendees Normal End-to-End Flow
  // -----------------------------------------------------------------
  await test('Scenario 1: 3+ attendees check in normally end-to-end (Scan -> Pending -> Webhook -> Checked In)', async () => {
    const attendeeIds = ['att-101', 'att-102', 'att-103'];
    const jobIds = [];

    // Step 1: Scan each attendee & assert immediate 202 Accepted + Pending state
    for (const id of attendeeIds) {
      const scanRes = await request({ method: 'POST', path: '/api/scan' }, { attendeeId: id });
      assert.strictEqual(scanRes.status, 202, `Expected 202 for ${id}`);
      assert.strictEqual(scanRes.body.status, AttendeeState.PRINT_REQUESTED);
      assert.ok(scanRes.body.jobId, 'Expected non-null jobId');
      jobIds.push(scanRes.body.jobId);
    }

    // Step 2: Allow mock printer worker to process and fire HMAC webhook
    await delay(350);

    // Step 3: Verify all 3 attendees reached CHECKED_IN state
    for (let i = 0; i < attendeeIds.length; i++) {
      const id = attendeeIds[i];
      const getRes = await request({ method: 'GET', path: `/api/attendees/${id}` });
      assert.strictEqual(getRes.status, 200);
      assert.strictEqual(getRes.body.attendee.status, AttendeeState.CHECKED_IN);
      assert.strictEqual(getRes.body.attendee.currentJobId, jobIds[i]);
      assert.ok(getRes.body.attendee.checkedInAt, 'checkedInAt timestamp should be populated');
    }
  });

  // -----------------------------------------------------------------
  // SCENARIO 2: Duplicate Scan Protection & Concurrency Safety
  // -----------------------------------------------------------------
  await test('Scenario 2: Duplicate scan protection (Simultaneous & Sequential scans do not create duplicate jobs)', async () => {
    const id = 'att-104';

    // Fire two scans simultaneously
    const [res1, res2] = await Promise.all([
      request({ method: 'POST', path: '/api/scan' }, { attendeeId: id }),
      request({ method: 'POST', path: '/api/scan' }, { attendeeId: id }),
    ]);

    // One must succeed with 202 and the other must be recognized as duplicate
    const acceptedCount = [res1, res2].filter((r) => r.status === 202).length;
    const duplicateCount = [res1, res2].filter((r) => r.body.isDuplicate === true).length;

    assert.strictEqual(acceptedCount, 1, 'Exactly one scan must receive 202 Accepted');
    assert.strictEqual(duplicateCount, 1, 'Duplicate scan must be blocked');

    // Wait for print completion
    await delay(250);

    // Try scanning again once CHECKED_IN
    const res3 = await request({ method: 'POST', path: '/api/scan' }, { attendeeId: id });
    assert.strictEqual(res3.body.isDuplicate, true);
    assert.strictEqual(res3.body.reason, 'ALREADY_CHECKED_IN');

    // Verify attendee history only has ONE print job recorded
    const getRes = await request({ method: 'GET', path: `/api/attendees/${id}` });
    assert.strictEqual(getRes.body.attendee.jobHistory.length, 1, 'Must only have 1 job in history');
    assert.strictEqual(getRes.body.attendee.status, AttendeeState.CHECKED_IN);
  });

  // -----------------------------------------------------------------
  // SCENARIO 3: Out-of-Order Webhooks & Stale Job ID Invalidation
  // -----------------------------------------------------------------
  await test('Scenario 3: Out-of-order webhook delivery (Stale callback from superseded job does not overwrite state)', async () => {
    const id = 'att-105';

    // Step 1: Force failure for first attempt to trigger retry flow
    await request({ method: 'POST', path: '/api/simulate/force-failure' }, { attendeeId: id, shouldFail: true });
    const scanRes = await request({ method: 'POST', path: '/api/scan' }, { attendeeId: id });
    const firstJobId = scanRes.body.jobId;

    // Wait for failure callback
    await delay(250);
    const failedCheck = await request({ method: 'GET', path: `/api/attendees/${id}` });
    assert.strictEqual(failedCheck.body.attendee.status, AttendeeState.PRINT_FAILED);

    // Step 2: Unset failure and trigger retry (generates secondJobId)
    await request({ method: 'POST', path: '/api/simulate/force-failure' }, { attendeeId: id, shouldFail: false });
    const retryRes = await request({ method: 'POST', path: '/api/retry' }, { attendeeId: id });
    const secondJobId = retryRes.body.jobId;
    assert.notStrictEqual(firstJobId, secondJobId, 'Retry must generate a new jobId');

    // Step 3: Simulate out-of-order late SUCCESS arriving for the OLD firstJobId
    const stalePayload = {
      jobId: firstJobId,
      attendeeId: id,
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
    };
    const signature = computeSignature(stalePayload);
    const staleRes = await request(
      {
        method: 'POST',
        path: '/api/webhooks/printer',
        headers: { 'X-Solstice-Signature': signature },
      },
      stalePayload
    );

    assert.strictEqual(staleRes.status, 200);
    assert.strictEqual(staleRes.body.ignored, true);
    assert.strictEqual(staleRes.body.reason, 'SUPERSEDED_OR_STALE_JOB');

    // Step 4: Allow secondJobId to finish naturally
    await delay(250);
    const finalCheck = await request({ method: 'GET', path: `/api/attendees/${id}` });
    assert.strictEqual(finalCheck.body.attendee.status, AttendeeState.CHECKED_IN);
    assert.strictEqual(finalCheck.body.attendee.currentJobId, secondJobId);
  });

  // -----------------------------------------------------------------
  // SCENARIO 4: Failed Print Job & Retry Lifecycle
  // -----------------------------------------------------------------
  await test('Scenario 4: Failed print job lifecycle (PRINT_FAILED state -> Retry -> CHECKED_IN)', async () => {
    const id = 'att-102';

    // Step 1: Force failure
    await request({ method: 'POST', path: '/api/simulate/force-failure' }, { attendeeId: id, shouldFail: true });
    await request({ method: 'POST', path: '/api/scan' }, { attendeeId: id });

    // Wait for webhook failure callback
    await delay(250);

    const check1 = await request({ method: 'GET', path: `/api/attendees/${id}` });
    assert.strictEqual(check1.body.attendee.status, AttendeeState.PRINT_FAILED);
    assert.ok(check1.body.attendee.lastError, 'Expected error details in attendee');

    // Step 2: Retry with failure cleared
    await request({ method: 'POST', path: '/api/simulate/force-failure' }, { attendeeId: id, shouldFail: false });
    const retryRes = await request({ method: 'POST', path: '/api/retry' }, { attendeeId: id });
    assert.strictEqual(retryRes.status, 202);
    assert.strictEqual(retryRes.body.status, AttendeeState.PRINT_REQUESTED);

    // Wait for retry completion
    await delay(250);

    const check2 = await request({ method: 'GET', path: `/api/attendees/${id}` });
    assert.strictEqual(check2.body.attendee.status, AttendeeState.CHECKED_IN);
  });

  // -----------------------------------------------------------------
  // SCENARIO 5: Webhook Security (HMAC Authentication) & Idempotency
  // -----------------------------------------------------------------
  await test('Scenario 5: Webhook HMAC security verification and idempotent duplicate delivery', async () => {
    const id = 'att-103';
    const scanRes = await request({ method: 'POST', path: '/api/scan' }, { attendeeId: id });
    const jobId = scanRes.body.jobId;

    const payload = {
      jobId,
      attendeeId: id,
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
    };

    // Sub-test 1: Missing signature header
    const unsignedRes = await request({ method: 'POST', path: '/api/webhooks/printer' }, payload);
    assert.strictEqual(unsignedRes.status, 401, 'Unsigned webhook must be rejected with 401');

    // Sub-test 2: Tampered / invalid signature
    const forgedRes = await request(
      {
        method: 'POST',
        path: '/api/webhooks/printer',
        headers: { 'X-Solstice-Signature': 'sha256=bad123invaliddeadbeef' },
      },
      payload
    );
    assert.strictEqual(forgedRes.status, 401, 'Tampered signature must be rejected with 401');

    // Sub-test 3: Valid signature
    const validSig = computeSignature(payload);
    const validRes = await request(
      {
        method: 'POST',
        path: '/api/webhooks/printer',
        headers: { 'X-Solstice-Signature': validSig },
      },
      payload
    );
    assert.strictEqual(validRes.status, 200);
    assert.strictEqual(validRes.body.status, AttendeeState.CHECKED_IN);

    // Sub-test 4: Duplicate webhook delivery of same job (Idempotent NO-OP)
    const dupRes = await request(
      {
        method: 'POST',
        path: '/api/webhooks/printer',
        headers: { 'X-Solstice-Signature': validSig },
      },
      payload
    );
    assert.strictEqual(dupRes.status, 200);
    assert.strictEqual(dupRes.body.ignored, true);
    assert.strictEqual(dupRes.body.reason, 'IDEMPOTENT_NOOP');
  });

  // -----------------------------------------------------------------
  // SCENARIO 6: Polling /status/:attendee_id (Pending -> Checked In)
  // -----------------------------------------------------------------
  await test('Scenario 6: Polling endpoint /status/:attendee_id reflects state transitions', async () => {
    const id = 'att-101';

    // Before scan: status is NOT_CHECKED_IN
    const initialRes = await request({ method: 'GET', path: `/status/${id}` });
    assert.strictEqual(initialRes.status, 200);
    assert.strictEqual(initialRes.body.status, AttendeeState.NOT_CHECKED_IN);

    // Trigger scan
    await request({ method: 'POST', path: '/api/scan' }, { attendeeId: id });

    // Immediately poll: status is PRINT_REQUESTED
    const pendingRes = await request({ method: 'GET', path: `/status/${id}` });
    assert.strictEqual(pendingRes.status, 200);
    assert.strictEqual(pendingRes.body.status, AttendeeState.PRINT_REQUESTED);

    // Wait for webhook callback
    await delay(350);

    // Poll after confirmation: status is CHECKED_IN
    const confirmedRes = await request({ method: 'GET', path: `/status/${id}` });
    assert.strictEqual(confirmedRes.status, 200);
    assert.strictEqual(confirmedRes.body.status, AttendeeState.CHECKED_IN);
    assert.ok(confirmedRes.body.checkedInAt, 'Expected non-null checkedInAt');
  });

  // Restore printer delay
  mockPrinterWorker.setDelay(800);

  console.log('\n------------------------------------------------------');
  console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

module.exports = { runAllTests };
