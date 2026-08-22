const { EventEmitter } = require('events');

/**
 * In-Memory Asynchronous Message Queue Adapter
 * Provides realistic async queue semantics (FIFO, asynchronous dispatch, concurrency, ack/nack).
 */
class InMemoryAsyncQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = 'InMemoryAsyncQueue';
    this.defaultDelayMs = options.defaultDelayMs !== undefined ? options.defaultDelayMs : 50;
    this.concurrency = options.concurrency || 5;
    this.queues = new Map(); // queueName -> Array<Job>
    this.handlers = new Map(); // queueName -> Function
    this.activeWorkers = new Map(); // queueName -> count
    this.jobHistory = [];
  }

  /**
   * Publishes a message to the specified queue.
   * @param {string} queueName 
   * @param {object} payload 
   * @param {object} [options] 
   */
  async publish(queueName, payload, options = {}) {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
    }

    const job = {
      id: payload.jobId || `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      queue: queueName,
      payload,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      maxAttempts: options.maxAttempts || 3,
      delayMs: options.delayMs !== undefined ? options.delayMs : this.defaultDelayMs,
    };

    this.queues.get(queueName).push(job);
    this.jobHistory.push(job);

    this.emit('job:enqueued', { queue: queueName, job });

    // Trigger async processing
    setTimeout(() => {
      this._pumpQueue(queueName);
    }, job.delayMs);

    return { jobId: job.id, status: 'ENQUEUED' };
  }

  /**
   * Registers a worker handler for a queue.
   * @param {string} queueName 
   * @param {Function} handler async function(payload, job)
   */
  subscribe(queueName, handler) {
    this.handlers.set(queueName, handler);
    this.emit('worker:subscribed', { queue: queueName });
    this._pumpQueue(queueName);
  }

  _pumpQueue(queueName) {
    const queue = this.queues.get(queueName);
    const handler = this.handlers.get(queueName);
    const active = this.activeWorkers.get(queueName) || 0;

    if (!queue || queue.length === 0 || !handler) {
      return;
    }

    while (queue.length > 0 && (this.activeWorkers.get(queueName) || 0) < this.concurrency) {
      const currentActive = this.activeWorkers.get(queueName) || 0;
      this.activeWorkers.set(queueName, currentActive + 1);
      const job = queue.shift();

      (async () => {
        try {
          job.attempts += 1;
          job.startedAt = new Date().toISOString();
          this.emit('job:processing', { queue: queueName, job });

          await handler(job.payload, job);

          job.completedAt = new Date().toISOString();
          this.emit('job:completed', { queue: queueName, job });
        } catch (err) {
          job.failedAt = new Date().toISOString();
          job.lastError = err.message;
          this.emit('job:failed', { queue: queueName, job, error: err.message });

          if (job.attempts < job.maxAttempts) {
            queue.push(job);
          }
        } finally {
          const count = this.activeWorkers.get(queueName) || 1;
          this.activeWorkers.set(queueName, Math.max(0, count - 1));
          this._pumpQueue(queueName);
        }
      })();
    }
  }

  clear() {
    this.queues.clear();
    this.jobHistory = [];
  }
}

/**
 * Optional RabbitMQ Adapter (using amqplib if RABBITMQ_URL is configured)
 */
class RabbitMQAdapter extends EventEmitter {
  constructor(url) {
    super();
    this.url = url || process.env.RABBITMQ_URL;
    this.name = 'RabbitMQAdapter';
    this.connection = null;
    this.channel = null;
  }

  async init() {
    try {
      const amqp = require('amqplib');
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      this.emit('ready');
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  async publish(queueName, payload) {
    if (!this.channel) await this.init();
    await this.channel.assertQueue(queueName, { durable: true });
    this.channel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      messageId: payload.jobId,
    });
    return { jobId: payload.jobId, status: 'ENQUEUED' };
  }

  async subscribe(queueName, handler) {
    if (!this.channel) await this.init();
    await this.channel.assertQueue(queueName, { durable: true });
    await this.channel.consume(queueName, async (msg) => {
      if (msg !== null) {
        try {
          const payload = JSON.parse(msg.content.toString());
          await handler(payload, { id: msg.properties.messageId });
          this.channel.ack(msg);
        } catch (err) {
          this.channel.nack(msg, false, false);
        }
      }
    });
  }
}

/**
 * Factory to create the active queue adapter.
 * Uses InMemoryAsyncQueue by default for zero-dependency reliability,
 * or RabbitMQAdapter if RABBITMQ_URL is set and active.
 */
function createQueue() {
  if (process.env.RABBITMQ_URL) {
    try {
      return new RabbitMQAdapter(process.env.RABBITMQ_URL);
    } catch (e) {
      console.warn('[Queue] Failed to init RabbitMQ, falling back to InMemoryAsyncQueue:', e.message);
    }
  }
  return new InMemoryAsyncQueue({ defaultDelayMs: 150 });
}

const defaultQueue = createQueue();

module.exports = {
  InMemoryAsyncQueue,
  RabbitMQAdapter,
  createQueue,
  defaultQueue,
};
