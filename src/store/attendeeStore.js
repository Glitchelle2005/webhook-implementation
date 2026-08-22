const { AttendeeState, AllowedTransitions, SEED_ATTENDEES } = require('../models/attendee');

class AttendeeStore {
  constructor() {
    this.attendees = new Map();
    this.locks = new Map(); // Async mutex lock per attendee to guarantee safe CAS
    this.reset();
  }

  /**
   * Resets the store with fresh copies of seed attendees.
   */
  reset() {
    this.attendees.clear();
    this.locks.clear();
    for (const seed of SEED_ATTENDEES) {
      this.attendees.set(seed.id, {
        ...seed,
        status: AttendeeState.NOT_CHECKED_IN,
        currentJobId: null,
        jobHistory: [],
        checkedInAt: null,
        lastError: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Acquires an exclusive async lock for an attendee ID.
   * Ensures atomic check-and-set operations across asynchronous event loop turns.
   */
  async _acquireLock(attendeeId) {
    while (this.locks.get(attendeeId)) {
      await this.locks.get(attendeeId);
    }
    let resolver;
    const promise = new Promise((resolve) => {
      resolver = resolve;
    });
    this.locks.set(attendeeId, promise);
    return () => {
      this.locks.delete(attendeeId);
      resolver();
    };
  }

  /**
   * Gets an attendee by ID (cloned to avoid direct external mutation).
   */
  get(attendeeId) {
    const attendee = this.attendees.get(attendeeId);
    return attendee ? JSON.parse(JSON.stringify(attendee)) : null;
  }

  /**
   * Gets an attendee by QR Code string.
   */
  findByQrCode(qrCode) {
    for (const att of this.attendees.values()) {
      if (att.qrCode === qrCode || att.id === qrCode) {
        return JSON.parse(JSON.stringify(att));
      }
    }
    return null;
  }

  /**
   * Returns list of all attendees.
   */
  getAll() {
    return Array.from(this.attendees.values()).map((att) =>
      JSON.parse(JSON.stringify(att))
    );
  }

  /**
   * Atomic Check-and-Set: Transitions attendee from NOT_CHECKED_IN or PRINT_FAILED to PRINT_REQUESTED.
   * Prevents race conditions from simultaneous duplicate scans.
   * 
   * @param {string} attendeeId 
   * @param {string} jobId - Unique request/job UUID (idempotency key)
   * @returns {Promise<{ success: boolean, reason?: string, attendee: object, isDuplicate?: boolean }>}
   */
  async requestPrint(attendeeId, jobId) {
    const releaseLock = await this._acquireLock(attendeeId);
    try {
      const attendee = this.attendees.get(attendeeId);
      if (!attendee) {
        return { success: false, reason: 'NOT_FOUND', attendee: null };
      }

      // Check current state
      if (attendee.status === AttendeeState.CHECKED_IN) {
        return {
          success: false,
          isDuplicate: true,
          reason: 'ALREADY_CHECKED_IN',
          message: `${attendee.name} is already checked in.`,
          attendee: JSON.parse(JSON.stringify(attendee)),
        };
      }

      if (attendee.status === AttendeeState.PRINT_REQUESTED) {
        return {
          success: false,
          isDuplicate: true,
          reason: 'ALREADY_PENDING',
          message: `Badge print job is already in progress for ${attendee.name} (Job: ${attendee.currentJobId}).`,
          attendee: JSON.parse(JSON.stringify(attendee)),
        };
      }

      // Validate allowed transition
      const allowed = AllowedTransitions[attendee.status];
      if (!allowed || !allowed.includes(AttendeeState.PRINT_REQUESTED)) {
        return {
          success: false,
          reason: 'INVALID_TRANSITION',
          message: `Cannot transition from ${attendee.status} to ${AttendeeState.PRINT_REQUESTED}`,
          attendee: JSON.parse(JSON.stringify(attendee)),
        };
      }

      // Perform atomic update
      const now = new Date().toISOString();
      attendee.status = AttendeeState.PRINT_REQUESTED;
      attendee.currentJobId = jobId;
      attendee.lastError = null;
      attendee.version += 1;
      attendee.updatedAt = now;
      attendee.jobHistory.push({
        jobId,
        requestedAt: now,
        completedAt: null,
        status: AttendeeState.PRINT_REQUESTED,
        error: null,
      });

      return {
        success: true,
        attendee: JSON.parse(JSON.stringify(attendee)),
        jobId,
      };
    } finally {
      releaseLock();
    }
  }

  /**
   * Webhook Callback State Handler: Completes a print job.
   * Validates idempotency and ignores superseded/stale job IDs.
   * 
   * @param {string} attendeeId 
   * @param {string} jobId 
   * @param {'SUCCESS'|'FAILED'} resultStatus 
   * @param {object} [errorDetails] 
   * @returns {Promise<{ success: boolean, reason?: string, attendee: object, ignored?: boolean }>}
   */
  async completePrint(attendeeId, jobId, resultStatus, errorDetails = null) {
    const releaseLock = await this._acquireLock(attendeeId);
    try {
      const attendee = this.attendees.get(attendeeId);
      if (!attendee) {
        return { success: false, reason: 'NOT_FOUND', attendee: null };
      }

      const now = new Date().toISOString();

      // Find the specific job record in history
      const jobRecord = attendee.jobHistory.find((j) => j.jobId === jobId);

      // Check if this callback belongs to the CURRENT active job
      if (attendee.currentJobId !== jobId) {
        // Stale or superseded job!
        if (jobRecord) {
          jobRecord.completedAt = now;
          jobRecord.status = resultStatus === 'SUCCESS' ? 'SUPERSEDED_SUCCESS' : 'SUPERSEDED_FAILED';
          jobRecord.error = errorDetails || 'Job was superseded by a newer request';
        }
        return {
          success: false,
          ignored: true,
          reason: 'SUPERSEDED_OR_STALE_JOB',
          message: `Received webhook for stale job "${jobId}", but active job is "${attendee.currentJobId}". Ignored to prevent corrupting state.`,
          attendee: JSON.parse(JSON.stringify(attendee)),
        };
      }

      // Check for duplicate webhook on already-completed state (Idempotency)
      if (resultStatus === 'SUCCESS' && attendee.status === AttendeeState.CHECKED_IN) {
        return {
          success: true,
          ignored: true,
          reason: 'IDEMPOTENT_NOOP',
          message: `Attendee ${attendee.name} is already checked in for job "${jobId}". Duplicate webhook ignored.`,
          attendee: JSON.parse(JSON.stringify(attendee)),
        };
      }

      if (resultStatus === 'FAILED' && attendee.status === AttendeeState.PRINT_FAILED) {
        return {
          success: true,
          ignored: true,
          reason: 'IDEMPOTENT_NOOP',
          message: `Attendee ${attendee.name} is already in PRINT_FAILED state for job "${jobId}". Duplicate webhook ignored.`,
          attendee: JSON.parse(JSON.stringify(attendee)),
        };
      }

      // Enforce state transition
      const targetState = resultStatus === 'SUCCESS' ? AttendeeState.CHECKED_IN : AttendeeState.PRINT_FAILED;
      const allowed = AllowedTransitions[attendee.status];
      if (!allowed || !allowed.includes(targetState)) {
        return {
          success: false,
          reason: 'INVALID_TRANSITION',
          message: `Cannot transition state from ${attendee.status} to ${targetState}`,
          attendee: JSON.parse(JSON.stringify(attendee)),
        };
      }

      // Apply transition
      attendee.status = targetState;
      attendee.version += 1;
      attendee.updatedAt = now;

      if (jobRecord) {
        jobRecord.completedAt = now;
        jobRecord.status = targetState;
        jobRecord.error = errorDetails;
      }

      if (resultStatus === 'SUCCESS') {
        attendee.checkedInAt = now;
        attendee.lastError = null;
      } else {
        attendee.lastError = errorDetails || { message: 'Badge printer hardware error / paper jam' };
      }

      return {
        success: true,
        attendee: JSON.parse(JSON.stringify(attendee)),
      };
    } finally {
      releaseLock();
    }
  }
}

// Singleton instance for kiosk service
const attendeeStore = new AttendeeStore();

module.exports = {
  AttendeeStore,
  attendeeStore,
};
