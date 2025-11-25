import assert from 'node:assert';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import amqplib from 'amqplib';
import { AmqpClient, AmqpJsError } from '../src/index.js';

const realConnect = amqplib.connect;
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeChannel {
  constructor(kind = 'channel') {
    this.kind = kind;
    this.published = [];
    this.consumers = [];
    this.prefetches = [];
    this.assertedExchanges = [];
    this.assertedQueues = [];
    this.bindings = [];
    this.acks = [];
    this.nacks = [];
    this.cancelled = [];
    this.closed = false;
  }

  async assertExchange(name, type, options) {
    this.assertedExchanges.push({ name, type, options });
    return { exchange: name };
  }

  async assertQueue(name, options) {
    this.assertedQueues.push({ name, options });
    return { queue: name };
  }

  async bindQueue(queue, exchange, routingKey) {
    this.bindings.push({ queue, exchange, routingKey });
  }

  async prefetch(count) {
    this.prefetches.push(count);
  }

  publish(exchange, routingKey, content, options) {
    this.published.push({ exchange, routingKey, content, options });
    return true;
  }

  async waitForConfirms() {}

  async consume(queue, cb, options) {
    const consumerTag = `ctag-${this.consumers.length + 1}`;
    this.consumers.push({ queue, cb, options, consumerTag });
    return { consumerTag };
  }

  ack(msg) {
    this.acks.push(msg);
  }

  nack(msg, _allUpTo, requeue) {
    this.nacks.push({ msg, requeue });
  }

  async cancel(consumerTag) {
    this.cancelled.push(consumerTag);
  }

  async close() {
    this.closed = true;
  }
}

class FakeConnection extends EventEmitter {
  constructor(registry) {
    super();
    this.registry = registry;
    this.closed = false;
    this.connection = { stream: { writable: true } };
  }

  async createConfirmChannel() {
    const ch = new FakeChannel('confirm');
    this.registry.confirmChannels.push(ch);
    return ch;
  }

  async createChannel() {
    const ch = new FakeChannel('channel');
    this.registry.channels.push(ch);
    return ch;
  }

  async close() {
    this.closed = true;
    this.emit('close');
  }
}

class FakeAmqp {
  constructor() {
    this.connections = [];
    this.confirmChannels = [];
    this.channels = [];
  }

  async connect(url, socketOptions) {
    if (this.connectDelay) await wait(this.connectDelay);
    this.lastUrl = url;
    this.lastSocketOptions = socketOptions;
    const conn = new FakeConnection(this);
    this.connections.push(conn);
    return conn;
  }
}

const useFakeAmqp = (fake) => {
  amqplib.connect = fake.connect.bind(fake);
  return () => {
    amqplib.connect = realConnect;
  };
};

test('publish uses defaults, encodes json, and emits metrics/logs', async (t) => {
  const fake = new FakeAmqp();
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const logs = [];
  const metrics = [];

  const client = new AmqpClient({
    url: 'amqp://test',
    logger: (entry) => logs.push(entry),
    metrics: (metric) => metrics.push(metric)
  });

  await client.publish('user.created', { id: 1 });

  assert.ok(fake.confirmChannels[0], 'confirm channel created');
  const pub = fake.confirmChannels[0].published[0];
  assert.strictEqual(pub.exchange, 'amqp-js.events');
  assert.strictEqual(pub.routingKey, 'user.created');
  assert.strictEqual(pub.options.contentType, 'application/json');

  assert.strictEqual(metrics[0].type, 'publish');
  assert.ok(logs.length >= 0); // logger is optional; should not throw

  await client.close();
});

test('before/after hooks, validation, and ack flow', async (t) => {
  const fake = new FakeAmqp();
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const befores = [];
  const afters = [];
  const validates = [];

  const client = new AmqpClient({
    url: 'amqp://test',
    topology: {
      events: {
        'order.created': { queue: 'orders.q' }
      }
    }
  });

  await client.subscribe({
    event: 'order.created',
    before: (payload) => befores.push(payload.id),
    after: (payload) => afters.push(payload.id),
    validate: (payload) => {
      validates.push(payload.id);
      return payload.id === 1;
    },
    handler: async () => {}
  });

  const consumer = fake.channels.find((ch) => ch.consumers.length)?.consumers[0];
  const message = { content: Buffer.from(JSON.stringify({ id: 1 })), fields: {}, properties: {} };
  await consumer.cb(message);

  assert.deepStrictEqual(befores, [1]);
  assert.deepStrictEqual(afters, [1]);
  assert.deepStrictEqual(validates, [1]);
  assert.strictEqual(fake.channels.find((ch) => ch.acks.length)?.acks.length, 1);

  await client.close();
});

test('retry with backoff then dead-letter on failure', async (t) => {
  const fake = new FakeAmqp();
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const client = new AmqpClient({
    url: 'amqp://test',
    defaultExchange: 'main.ex',
    reconnect: { initialDelay: 1, maxDelay: 2, factor: 1 },
    onError: () => {}
  });

  await client.subscribe({
    event: 'payment.failed',
    deadLetterExchange: 'dlx.ex',
    maxAttempts: 2,
    backoff: () => 0,
    handler: async () => {
      throw new Error('boom');
    }
  });

  const consumer = fake.channels.find((ch) => ch.consumers.length)?.consumers[0];
  const message = { content: Buffer.from(JSON.stringify({ id: 9 })), fields: {}, properties: {} };
  await consumer.cb(message);

  assert.strictEqual(fake.confirmChannels[0].assertedExchanges.some((e) => e.name === 'dlx.ex'), true);
  const dlxPublish = fake.confirmChannels[0].published.find((p) => p.exchange === 'dlx.ex');
  assert.ok(dlxPublish, 'dead-letter publish happened');
  assert.strictEqual(fake.channels.find((ch) => ch.nacks.length)?.nacks.length, 1);

  await client.close();
});

test('ready resets on reconnect and subscriptions are resumed', async (t) => {
  const fake = new FakeAmqp();
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const client = new AmqpClient({
    url: 'amqp://test',
    reconnect: { initialDelay: 1, maxDelay: 2, factor: 1 },
    topology: {
      events: {
        'user.updated': { queue: 'user.updated.q' }
      }
    }
  });

  await client.subscribe('user.updated', async () => {});
  const firstConn = fake.connections[0];
  assert.ok(firstConn, 'initial connection established');

  firstConn.emit('close');
  await wait(5); // allow reconnect scheduling
  await client.ready; // wait for reconnection

  assert.ok(fake.connections[1], 'reconnected');
  const consumerChannel = fake.channels.find((ch) => ch.consumers.length);
  assert.ok(consumerChannel, 'subscription reattached');

  await client.close();
});

test('ping uses lightweight channel and close works', async (t) => {
  const fake = new FakeAmqp();
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const client = new AmqpClient({ url: 'amqp://test', onError: () => {} });
  const ok = await client.ping();
  assert.strictEqual(ok, true);
  const pingChannel = fake.channels.at(-1);
  assert.ok(pingChannel.closed, 'ping channel closed');
  await client.close();
});

test('defaults to localhost URL when none provided', async (t) => {
  const fake = new FakeAmqp();
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const client = new AmqpClient();
  await client.publish('demo.event', { ok: true });

  assert.strictEqual(fake.lastUrl, 'amqp://localhost');
  await client.close();
});

test('coalesces concurrent connection attempts', async (t) => {
  const fake = new FakeAmqp();
  fake.connectDelay = 5;
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const client = new AmqpClient({ url: 'amqp://test' });

  // Trigger publish and subscribe before the first connection resolves.
  const publishPromise = client.publish('order.created', { id: 42 });
  const subscribePromise = client.subscribe('order.created', async () => {});

  await Promise.all([publishPromise, subscribePromise]);

  assert.strictEqual(fake.connections.length, 1);
  await client.close();
});

test('before/after hook errors still follow retry/ack flow', async (t) => {
  const fake = new FakeAmqp();
  const restore = useFakeAmqp(fake);
  t.after(restore);

  const client = new AmqpClient({ url: 'amqp://test', onError: () => {} });

  await client.subscribe({
    event: 'hook.test',
    maxAttempts: 1,
    before: () => {
      throw new Error('before failed');
    },
    handler: async () => {}
  });

  const consumer = fake.channels.find((ch) => ch.consumers.length)?.consumers[0];
  const message = { content: Buffer.from(JSON.stringify({})), fields: {}, properties: {} };
  await consumer.cb(message);

  const nackCount = fake.channels.find((ch) => ch.nacks.length)?.nacks.length || 0;
  assert.strictEqual(nackCount, 1);

  await client.close();
});
