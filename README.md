# @cryptoaaron/amqp-js

Lightweight RabbitMQ wrapper on `amqplib` with declarative topology, auto reconnect/resubscribe, health helpers, metrics/logging hooks, and ergonomic retries/dead-lettering. No implicit dotenv—pass your URL or call the helper yourself.

## Install

```bash
npm install @cryptoaaron/amqp-js
```

## Setup

```js
import { createClient, loadEnv } from '@cryptoaaron/amqp-js';

// Optional: you control when env is loaded
loadEnv(); // or skip and just set process.env yourself

const client = createClient({
  url: process.env.AMQP_URL // required
});
```

## Quick start

```js
await client.publish('user.created', { id: '123', email: 'hi@example.com' });

await client.subscribe('user.created', async (payload, meta) => {
  console.log('received', payload, meta.fields.routingKey);
});

await client.ready; // waits for connection + subscriptions
```

### Declarative topology + publish helper

```js
const client = createClient({
  url: process.env.AMQP_URL,
  topology: {
    events: {
      'user.created': { exchange: 'app.events', routingKey: 'user.created', queue: 'app.events.user.created' },
      'user.deleted': { exchange: 'app.events', routingKey: 'user.deleted' }
    }
  }
});

await client.publish('user.created', { id: '123' }); // validated against registry
```

### Resilient consumers (retries, hooks, dead-letter)

```js
await client.subscribe({
  event: 'user.created',
  queue: 'app.events.user.created',
  prefetch: 20,
  maxAttempts: 5,
  backoff: (attempt) => attempt * 250, // ms
  deadLetterExchange: 'app.events.dlq',
  before: (payload) => console.log('before', payload),
  after: (payload) => console.log('after', payload),
  handler: async (payload) => {
    // your work here
  }
});
```

### Observability hooks

```js
const client = createClient({
  url: process.env.AMQP_URL,
  logger: ({ level, message, context }) => console.log(level, message, context),
  metrics: ({ type, totals }) => console.log(type, totals)
});
```

## API surface

- `createClient(options)` / `new AmqpClient(options)`
  - `url` (required): AMQP connection string (no auto dotenv)
  - `name`: connection name (default `amqp-js`)
  - `topology.events`: map `{ [eventName]: { exchange, routingKey, queue?, exchangeType?, queueOptions?, exchangeOptions?, prefetch?, deadLetterExchange?, deadLetterRoutingKey?, deadLetterExchangeType?, validate?, headers? } }`
  - `defaultExchange`: defaults to `amqp-js.events` (topic)
  - `defaultQueueOptions`: defaults to `{ durable: true }`
  - `prefetch`: default consumer prefetch (10)
  - `publishDefaults`: `{ persistent?: boolean }` (defaults to true)
  - `reconnect`: `{ initialDelay?, maxDelay?, factor? }` (defaults 500/5000/2)
  - `logger(entry)` and `metrics(metric)` hooks
  - `onError(err)`: error sink for handler/connection errors

- `publish(eventOrOptions, payload?)`
  - If `eventOrOptions` is a string, uses topology entry (`exchange`, `routingKey`, `validate`) and sends `payload`.
  - If object, you can pass `event`, `exchange`, `routingKey`, `message/payload`, `headers`, `serializeJson`, `persistent`, `contentType`, `validate`.

- `subscribe(eventOrOptions, handler?)`
  - If string, uses topology; otherwise options: `event`, `queue`, `exchange`, `routingKey`, `prefetch`, `queueOptions`, `parseJson` (default true), `maxAttempts` (default 3), `backoff(attempt)` (default `Math.min(1000*attempt, 5000)`), `requeueOnError` (default false), `deadLetterExchange`, `deadLetterRoutingKey`, `deadLetterExchangeType`, `validate(payload)`, `before`/`after` hooks (single or array), `handler`.
  - Returns `{ id, cancel }`.

- `ready`: promise that resolves after connection + topology + subscriptions are ready (resets on reconnect).
- `ping()`: returns true/false by opening/closing a lightweight channel.
- `isConnected()`: best-effort connectivity check.
- `getMetrics()`: counters for `publish/consume/ack/nack/reconnect`.
- `close()`: cancels subscriptions, closes channels/connection.
- `loadEnv(options?)`: proxy to `dotenv.config` for optional env loading.

## Defaults (zero-config)

- Exchange: durable `topic` named `amqp-js.events`.
- Queue naming: `<name>.<event>.queue` (e.g., `amqp-js.user.created.queue`) when `queue` is not specified.
- Messages: JSON-encoded objects, persistent by default.
- Prefetch: 10 per subscription.

## TypeScript

Type declarations are shipped via `src/index.d.ts`; imports work with ESM:

```ts
import { createClient, AmqpClient } from '@cryptoaaron/amqp-js';
```

## Testing

```bash
npm test                                        # unit-only (no broker needed)
AMQP_URL=... RUN_AMQP_INTEGRATION=true npm test # runs live round-trip
```

## License

MIT
