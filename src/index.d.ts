export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = (entry: { level: LogLevel; message: string; context?: Record<string, unknown> }) => void;

export type MetricType = 'publish' | 'consume' | 'ack' | 'nack' | 'reconnect';
export type MetricsHook = (metric: { type: MetricType; data?: Record<string, unknown>; totals: MetricsTotals }) => void;

export interface MetricsTotals {
  publishes: number;
  consumes: number;
  acks: number;
  nacks: number;
  reconnects: number;
}

export interface EventConfig {
  exchange?: string;
  routingKey?: string;
  queue?: string;
  exchangeType?: string;
  queueOptions?: Record<string, unknown>;
  exchangeOptions?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  validate?: (payload: unknown) => boolean;
  prefetch?: number;
  deadLetterExchange?: string;
  deadLetterRoutingKey?: string;
  deadLetterExchangeType?: string;
}

export interface Topology {
  events?: Record<string, EventConfig>;
}

export interface ReconnectOptions {
  initialDelay?: number;
  maxDelay?: number;
  factor?: number;
}

export interface PublishOptions {
  event?: string;
  message?: unknown;
  payload?: unknown;
  exchange?: string;
  routingKey?: string;
  exchangeType?: string;
  serializeJson?: boolean;
  persistent?: boolean;
  headers?: Record<string, unknown>;
  validate?: (payload: unknown) => boolean;
  contentType?: string;
}

export interface HandlerMeta {
  fields: unknown;
  properties: unknown;
  raw: unknown;
}

export type Hook = (payload: unknown, meta: HandlerMeta) => void | Promise<void>;
export type Handler = (payload: unknown, meta: HandlerMeta) => void | Promise<void>;

export interface SubscribeOptions {
  event?: string;
  queue?: string;
  exchange?: string;
  routingKey?: string;
  exchangeType?: string;
  prefetch?: number;
  queueOptions?: Record<string, unknown>;
  parseJson?: boolean;
  maxAttempts?: number;
  backoff?: (attempt: number) => number;
  requeueOnError?: boolean;
  deadLetterExchange?: string;
  deadLetterRoutingKey?: string;
  deadLetterExchangeType?: string;
  validate?: (payload: unknown) => boolean;
  before?: Hook | Hook[];
  after?: Hook | Hook[];
  handler?: Handler;
}

export interface AmqpClientOptions {
  url?: string;
  name?: string;
  socketOptions?: Record<string, unknown>;
  prefetch?: number;
  defaultExchange?: string;
  defaultExchangeType?: string;
  defaultQueueOptions?: Record<string, unknown>;
  publishDefaults?: { persistent?: boolean };
  topology?: Topology;
  reconnect?: ReconnectOptions;
  logger?: Logger;
  metrics?: MetricsHook;
  onError?: (err: unknown) => void;
}

export class AmqpJsError extends Error {
  context: Record<string, unknown>;
  constructor(message: string, context?: Record<string, unknown>, cause?: unknown);
}

export class AmqpClient {
  constructor(options?: AmqpClientOptions);
  ready: Promise<void>;
  connect(): Promise<unknown>;
  publish(eventOrOptions: string | PublishOptions, payload?: unknown): Promise<boolean>;
  subscribe(eventOrOptions: string | SubscribeOptions, handler?: Handler): Promise<{ id: string; cancel: () => Promise<void> }>;
  ping(): Promise<boolean>;
  isConnected(): boolean;
  getMetrics(): MetricsTotals;
  close(): Promise<void>;
}

export const createClient: (options?: AmqpClientOptions) => AmqpClient;
