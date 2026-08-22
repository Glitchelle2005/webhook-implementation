const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'solstice-kiosk-secret-key-2026';

/**
 * Computes HMAC-SHA256 signature for a payload.
 * @param {object|string} payload - Webhook payload
 * @param {string} secret - Secret key
 * @returns {string} - Hex signature with sha256= prefix
 */
function computeSignature(payload, secret = WEBHOOK_SECRET) {
  if (payload === undefined || payload === null) {
    return '';
  }
  let content;
  if (Buffer.isBuffer(payload)) {
    content = payload.toString('utf8');
  } else if (typeof payload === 'string') {
    content = payload;
  } else {
    content = JSON.stringify(payload);
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(content, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Validates the HMAC signature header against raw body or payload.
 * Uses timingSafeEqual to protect against timing attacks.
 * @param {object|string|Buffer} payload 
 * @param {string} signatureHeader 
 * @param {string} secret 
 * @returns {boolean}
 */
function verifySignature(payload, signatureHeader, secret = WEBHOOK_SECRET) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  try {
    const expectedSignature = computeSignature(payload, secret);
    if (!expectedSignature) return false;

    const signatureBuffer = Buffer.from(signatureHeader, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (signatureBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (err) {
    return false;
  }
}

/**
 * Validates the schema of a printer webhook callback payload.
 * @param {object} payload 
 * @returns {{ valid: boolean, error?: string }}
 */
function validateWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be a non-null object' };
  }

  const { attendeeId, jobId, status, timestamp } = payload;

  if (!attendeeId || typeof attendeeId !== 'string') {
    return { valid: false, error: 'Missing or invalid "attendeeId"' };
  }

  if (!jobId || typeof jobId !== 'string') {
    return { valid: false, error: 'Missing or invalid "jobId"' };
  }

  if (!status || !['SUCCESS', 'FAILED'].includes(status)) {
    return { valid: false, error: 'Status must be either "SUCCESS" or "FAILED"' };
  }

  if (!timestamp) {
    return { valid: false, error: 'Missing "timestamp"' };
  }

  return { valid: true };
}

module.exports = {
  WEBHOOK_SECRET,
  computeSignature,
  verifySignature,
  validateWebhookPayload,
};
