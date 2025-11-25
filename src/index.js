import amqplib from 'amqplib';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_PREFETCH = 10;
const DEFAULT_EXCHANGE = 'amqp-js.events';
const DEFAULT_QUEUE_OPTIONS = { durable: true };

export class AmqpJsError extends Error {
  constructor(message, context = {}, cause) {
    super(message);
    this.name = 'AmqpJsError';
    this.context = context;
    if (cause) this.cause = cause;
  }
}

export class AmqpClient {
  constructor(options = {}) {
    const {
      url = 'amqp://localhost',
      name = 'amqp-js',
      socketOptions = {},
      prefetch = DEFAULT_PREFETCH,
      defaultExchange = DEFAULT_EXCHANGE,
      defaultExchangeType = 'topic',
      defaultQueueOptions = DEFAULT_QUEUE_OPTIONS,
      publishDefaults = { persistent: true },
      topology = {},
      reconnect = {},
      logger,
      metrics,
      onError = console.error
    } = options;

    if (!url) {
      throw new AmqpJsError('AMQP connection URL is required; pass url explicitly.', { code: 'NO_URL' });
    }

    this.url = url;
    this.name = name;
    this.socketOptions = socketOptions;
    this.prefetch = prefetch;
    this.defaultExchange = defaultExchange;
    this.defaultExchangeType = defaultExchangeType;
    this.defaultQueueOptions = defaultQueueOptions;
    this.publishDefaults = publishDefaults;
    this.topology = topology.events ?? {};
    this.onError = onError;
    this.logFn = logger ?? (() => {});
    this.metricFn = metrics ?? (() => {});
    this.reconnectConfig = {
      initialDelay: reconnect.initialDelay ?? 500,
      maxDelay: reconnect.maxDelay ?? 5000,
      factor: reconnect.factor ?? 2
    };

    this.connection = null;
    this.publishChannel = null;
    this.subscriptions = new Map();
    this.closing = false;
    this.metricsState = { publishes: 0, consumes: 0, acks: 0, nacks: 0, reconnects: 0 };
    this._reconnectTimer = null;
    this.connectingPromise = null;
    this.#resetReady();
  }

  #resetReady() {
    let resolveReady;
    this.ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    this._resolveReady = resolveReady;
  }

  #log(level, message, context = {}) {
    try {
      this.logFn({ level, message, context });
    } catch {
      /* ignore logging failures */
    }
  }

  #metric(type, data) {
    if (type === 'publish') this.metricsState.publishes += 1;
    if (type === 'consume') this.metricsState.consumes += 1;
    if (type === 'ack') this.metricsState.acks += 1;
    if (type === 'nack') this.metricsState.nacks += 1;
    if (type === 'reconnect') this.metricsState.reconnects += 1;
    try {
      this.metricFn({ type, data, totals: { ...this.metricsState } });
    } catch {
      /* ignore metric failures */
    }
  }

  getMetrics() {
    return { ...this.metricsState };
  }

  isConnected() {
    return Boolean(this.connection && this.connection.connection?.stream?.writable && !this.connection.closing);
  }

  async ping() {
    try {
      const connection = await this.#getConnection();
      const channel = await connection.createChannel();
      await channel.close();
      return true;
    } catch (err) {
      this.#log('error', 'ping failed', { error: err });
      return false;
    }
  }

  async connect() {
    await this.#getConnection();
    return this.connection;
  }

  async #getConnection() {
    if (this.connection && this.isConnected()) return this.connection;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = this.#connectWithRetry().finally(() => {
      this.connectingPromise = null;
    });
    return this.connectingPromise;
  }

  async #connectWithRetry() {
    if (this.closing) return null;

    let delayMs = this.reconnectConfig.initialDelay;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.#openConnection();
        this._resolveReady?.();
        return this.connection;
      } catch (err) {
        if (this.closing) return null;
        this.#log('error', 'connection attempt failed', { error: err });
        this.onError?.(err);
        this.#metric('reconnect');
        await delay(delayMs);
        delayMs = Math.min(this.reconnectConfig.maxDelay, delayMs * this.reconnectConfig.factor);
      }
    }
  }

  async #openConnection() {
    this.publishChannel = null;
    const connection = await amqplib.connect(this.url, {
      clientProperties: { connection_name: this.name },
      ...this.socketOptions
    });

    connection.on('close', () => {
      this.connection = null;
      this.publishChannel = null;
      this.#log('warn', 'connection closed');
      if (!this.closing) {
        this.#resetReady();
        this.#reconnectSoon();
      }
    });

    connection.on('error', (err) => {
      this.#log('error', 'connection error', { error: err });
      this.onError?.(err);
    });

    this.connection = connection;
    await this.#applyTopology();
    await this.#resubscribeAll();
  }

  #reconnectSoon() {
    if (this._reconnectTimer || this.closing) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      await this.#connectWithRetry();
    }, this.reconnectConfig.initialDelay);
  }

  #resolveEventConfig(eventName, throwOnMissing = true) {
    if (!eventName) return null;
    const config = this.topology[eventName];
    if (!config && throwOnMissing) {
      throw new AmqpJsError(`Unknown event "${eventName}"`, { event: eventName });
    }
    return config ?? null;
  }

  #defaultQueueName(event) {
    const safeEvent = event ? String(event).replace(/\s+/g, '.') : 'default';
    return `${this.name}.${safeEvent}.queue`;
  }

  async #getPublishChannel() {
    const connection = await this.#getConnection();
    if (this.publishChannel && this.publishChannel.connection === connection) return this.publishChannel;
    this.publishChannel = await connection.createConfirmChannel();
    return this.publishChannel;
  }

  async publish(eventOrOptions, payload) {
    const options = typeof eventOrOptions === 'string'
      ? { event: eventOrOptions, message: payload }
      : (eventOrOptions || {});

    const eventConfig = this.#resolveEventConfig(options.event, false) || {};
    const message = options.message ?? options.payload ?? payload;

    if (message === undefined || message === null) {
      throw new AmqpJsError('message is required to publish', { event: options.event });
    }

    const exchange = options.exchange ?? eventConfig.exchange ?? this.defaultExchange ?? '';
    const routingKey = options.routingKey ?? eventConfig.routingKey ?? options.event ?? '';
    const exchangeType = options.exchangeType ?? eventConfig.exchangeType ?? this.defaultExchangeType;
    const serializeJson = options.serializeJson ?? true;
    const persistent = options.persistent ?? this.publishDefaults.persistent ?? true;
    const headers = { ...(eventConfig.headers || {}), ...(options.headers || {}) };
    const validate = options.validate ?? eventConfig.validate;
    if (validate && !validate(message)) {
      throw new AmqpJsError('payload failed validation', { event: options.event, routingKey });
    }

    const channel = await this.#getPublishChannel();
    if (exchange) {
      await channel.assertExchange(exchange, exchangeType, { durable: true, ...(eventConfig.exchangeOptions || {}) });
    }

    const { buffer, resolvedContentType } = this.#encodeMessage(message, serializeJson, options.contentType ?? eventConfig.contentType);

    const published = channel.publish(exchange, routingKey, buffer, {
      contentType: resolvedContentType,
      persistent,
      headers
    });

    await channel.waitForConfirms();
    this.#metric('publish', { event: options.event, routingKey, exchange });
    return published;
  }

  async subscribe(eventOrOptions, handlerMaybe) {
    const opts = typeof eventOrOptions === 'string'
      ? { event: eventOrOptions, handler: handlerMaybe }
      : (eventOrOptions || {});

    const handler = handlerMaybe || opts.handler;
    if (typeof handler !== 'function') {
      throw new AmqpJsError('handler function is required for subscribe', { code: 'NO_HANDLER' });
    }

    const eventConfig = this.#resolveEventConfig(opts.event, false) || {};
    const queue = opts.queue ?? eventConfig.queue ?? this.#defaultQueueName(opts.event);
    const exchange = opts.exchange ?? eventConfig.exchange ?? this.defaultExchange;
    const routingKey = opts.routingKey ?? eventConfig.routingKey ?? opts.event ?? '#';
    const exchangeType = opts.exchangeType ?? eventConfig.exchangeType ?? this.defaultExchangeType;
    const prefetch = opts.prefetch ?? eventConfig.prefetch ?? this.prefetch;
    const queueOptions = { ...this.defaultQueueOptions, ...(eventConfig.queueOptions || {}), ...(opts.queueOptions || {}) };
    const deadLetterExchange = opts.deadLetterExchange ?? eventConfig.deadLetterExchange;
    const deadLetterRoutingKey = opts.deadLetterRoutingKey ?? eventConfig.deadLetterRoutingKey ?? routingKey;

    const id = `${queue}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.subscriptions.set(id, {
      id,
      handler,
      options: {
        ...opts,
        eventConfig,
        queue,
        exchange,
        routingKey,
        exchangeType,
        prefetch,
        queueOptions,
        deadLetterExchange,
        deadLetterRoutingKey
      },
      channel: null,
      consumerTag: null
    });

    await this.#startSubscription(id);

    return {
      id,
      cancel: () => this.#cancelSubscription(id)
    };
  }

  async #startSubscription(id) {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    if (sub.channel) {
      await sub.channel.close().catch(() => {});
      sub.channel = null;
      sub.consumerTag = null;
    }
    const connection = await this.#getConnection();
    const channel = await connection.createChannel();

    const { queue, exchange, exchangeType, routingKey, prefetch, queueOptions, eventConfig } = sub.options;

    if (prefetch) await channel.prefetch(prefetch);
    await channel.assertQueue(queue, queueOptions);
    if (exchange) {
      await channel.assertExchange(exchange, exchangeType, { durable: true, ...(eventConfig?.exchangeOptions || {}) });
      await channel.bindQueue(queue, exchange, routingKey);
    }

    const consumeOptions = { noAck: false };
    const consumeHandler = async (msg) => {
      await this.#processMessage(sub, channel, msg);
    };

    const { consumerTag } = await channel.consume(queue, consumeHandler, consumeOptions);
    sub.channel = channel;
    sub.consumerTag = consumerTag;
  }

  async #processMessage(sub, channel, msg) {
    if (!msg) return;
    const options = sub.options;
    const parseJson = options.parseJson ?? true;
    const maxAttempts = options.maxAttempts ?? 3;
    const backoff = options.backoff ?? ((attempt) => Math.min(1000 * attempt, 5000));
    const requeueOnError = options.requeueOnError ?? false;
    const validate = options.validate ?? options.eventConfig?.validate;
    const beforeHooks = this.#normalizeHooks(options.before || options.middlewareBefore);
    const afterHooks = this.#normalizeHooks(options.after || options.middlewareAfter);
    const context = {
      event: options.event,
      queue: options.queue,
      routingKey: options.routingKey
    };

    const payload = parseJson ? this.#decodeMessage(msg.content) : msg.content;

    if (validate && !validate(payload)) {
      this.#log('warn', 'message failed schema/validation', context);
      channel.nack(msg, false, false);
      this.#metric('nack', { ...context, reason: 'validation' });
      return;
    }

    this.#metric('consume', context);

    let attempt = 1;
    while (attempt <= maxAttempts) {
      try {
        for (const hook of beforeHooks) {
          await hook(payload, { fields: msg.fields, properties: msg.properties, raw: msg });
        }

        await sub.handler(payload, {
          fields: msg.fields,
          properties: msg.properties,
          raw: msg
        });

        for (const hook of afterHooks) {
          await hook(payload, { fields: msg.fields, properties: msg.properties, raw: msg });
        }

        channel.ack(msg);
        this.#metric('ack', context);
        return;
      } catch (err) {
        this.#log('error', 'handler failed', { ...context, attempt, error: err });
        this.onError?.(err);

        if (attempt >= maxAttempts) {
          await this.#handleDeadLetter(msg, options, payload);
          channel.nack(msg, false, requeueOnError);
          this.#metric('nack', { ...context, attempt, deadLettered: Boolean(options.deadLetterExchange) });
          return;
        }

        await delay(backoff(attempt));
        attempt += 1;
      }
    }
  }

  async #handleDeadLetter(msg, options, payload) {
    if (!options.deadLetterExchange) return;

    try {
      const channel = await this.#getPublishChannel();
      const exchangeType = options.deadLetterExchangeType ?? 'topic';
      await channel.assertExchange(options.deadLetterExchange, exchangeType, { durable: true });
      const routingKey = options.deadLetterRoutingKey ?? options.routingKey ?? '';
      const contentType = msg.properties?.contentType;

      channel.publish(options.deadLetterExchange, routingKey, msg.content, {
        contentType,
        headers: {
          ...(msg.properties?.headers || {}),
          'x-death-original-queue': options.queue,
          'x-death-error': 'max retries exceeded'
        }
      });
      await channel.waitForConfirms();
      this.#log('info', 'dead-lettered message', { queue: options.queue, routingKey });
    } catch (err) {
      this.#log('error', 'dead-letter publish failed', { error: err, queue: options.queue });
      this.onError?.(err);
    }
  }

  #normalizeHooks(hooks) {
    if (!hooks) return [];
    return Array.isArray(hooks) ? hooks.filter(Boolean) : [hooks];
  }

  async #cancelSubscription(id) {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    if (sub.channel && sub.consumerTag) {
      await sub.channel.cancel(sub.consumerTag).catch(() => {});
    }
    if (sub.channel) {
      await sub.channel.close().catch(() => {});
    }
    this.subscriptions.delete(id);
  }

  async #resubscribeAll() {
    for (const id of this.subscriptions.keys()) {
      try {
        await this.#startSubscription(id);
      } catch (err) {
        this.#log('error', 'resubscribe failed', { id, error: err });
        this.onError?.(err);
      }
    }
  }

  async #applyTopology() {
    const connection = await this.#getConnection();
    const channel = await connection.createChannel();
    try {
      const events = Object.entries(this.topology);
      for (const [eventName, cfg] of events) {
        const exchange = cfg.exchange ?? this.defaultExchange;
        const exchangeType = cfg.exchangeType ?? this.defaultExchangeType;
        const queue = cfg.queue ?? this.#defaultQueueName(eventName);
        if (exchange) {
          await channel.assertExchange(exchange, exchangeType, { durable: true, ...(cfg.exchangeOptions || {}) });
        }
        if (queue) {
          await channel.assertQueue(queue, { ...this.defaultQueueOptions, ...(cfg.queueOptions || {}) });
          if (exchange) {
            const routingKey = cfg.routingKey ?? eventName;
            await channel.bindQueue(queue, exchange, routingKey);
          }
        }
      }
    } finally {
      await channel.close().catch(() => {});
    }
  }

  async close() {
    this.closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    for (const id of Array.from(this.subscriptions.keys())) {
      await this.#cancelSubscription(id);
    }

    if (this.publishChannel) {
      await this.publishChannel.close().catch(() => {});
      this.publishChannel = null;
    }

    if (this.connection) {
      await this.connection.close().catch(() => {});
      this.connection = null;
    }
  }

  #encodeMessage(message, serializeJson, explicitContentType) {
    if (Buffer.isBuffer(message)) {
      return { buffer: message, resolvedContentType: explicitContentType ?? 'application/octet-stream' };
    }

    if (serializeJson && typeof message === 'object') {
      return { buffer: Buffer.from(JSON.stringify(message)), resolvedContentType: explicitContentType ?? 'application/json' };
    }

    const stringValue = typeof message === 'string' ? message : String(message);
    return { buffer: Buffer.from(stringValue), resolvedContentType: explicitContentType ?? 'text/plain' };
  }

  #decodeMessage(buffer) {
    const text = buffer.toString();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

export const createClient = (options) => new AmqpClient(options);
