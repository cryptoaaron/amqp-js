import assert from 'node:assert';
import test from 'node:test';
import { AmqpClient } from '../src/index.js';

const url = process.env.AMQP_URL;
const runIntegration = Boolean(url && process.env.RUN_AMQP_INTEGRATION === 'true');

test('throws when no AMQP url is provided', () => {
  assert.throws(
    () => new AmqpClient({ url: '' }),
    /AMQP connection URL is required/
  );
});

test('publish and subscribe round-trip', { skip: !runIntegration && 'set AMQP_URL and RUN_AMQP_INTEGRATION=true to run integration test' }, async () => {
  const suffix = Date.now();
  const eventName = `amqp-js.test.event.${suffix}`;
  const exchange = `amqp-js.test.${suffix}.exchange`;
  const queue = `amqp-js.test.${suffix}.queue`;
  const routingKey = `demo.route.${suffix}`;
  const message = { run: 'integration', count: 1 };

  const client = new AmqpClient({
    url,
    name: 'amqp-js-test',
    topology: {
      events: {
        [eventName]: { exchange, routingKey, queue }
      }
    }
  });

  await client.connect();
  await client.ready;

  let received;
  const subscription = await client.subscribe({
    event: eventName,
    parseJson: true,
    handler: async (payload) => {
      received = payload;
    }
  });

  await client.publish({
    event: eventName,
    message
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for message')), 7000);
    const interval = setInterval(() => {
      if (received !== undefined) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });

  await subscription.cancel();
  await client.close();

  assert.deepStrictEqual(received, message);
});
