import {
  LogContext,
  TeeLogSink,
  consoleLogSink,
  type Context,
  type LogLevel,
  type LogSink,
} from '@rocicorp/logger';
import {pid} from 'node:process';
import {DatadogLogSink} from '../../../datadog/src/mod.js';
import {type LogConfig} from '../config/zero-config.js';
import {stringify} from '../types/bigint-json.js';

const DATADOG_SOURCE = 'zeroWorker';

function createLogSink(config: LogConfig) {
  const logSink = process.env['JSON_LOG_FORMAT']
    ? consoleJsonLogSink
    : consoleLogSink;
  if (config.datadogLogsApiKey === undefined) {
    return logSink;
  }
  return new TeeLogSink([
    new DatadogLogSink({
      apiKey: config.datadogLogsApiKey,
      service: config.datadogServiceLabel ?? '',
      source: DATADOG_SOURCE,
    }),
    logSink,
  ]);
}

export function createLogContext(
  config: LogConfig,
  context: {worker: string},
): LogContext {
  const ctx = {...context, pid};
  return new LogContext(config.level, ctx, createLogSink(config));
}

const consoleJsonLogSink: LogSink = {
  log(level: LogLevel, context: Context | undefined, ...args: unknown[]): void {
    // If the last arg is an object or an Error, combine those fields into the message.
    const lastObj = errorOrObject(args.at(-1));
    if (lastObj) {
      args.pop();
    }
    const message = args.length
      ? {
          message: args
            .map(s => (typeof s === 'string' ? s : stringify(s)))
            .join(' '),
        }
      : undefined;

    console[level]({
      ...context,
      ...message,
      ...lastObj,
    });
  },
};

function errorOrObject(v: unknown): object | undefined {
  if (v instanceof Error) {
    return {
      name: v.name,
      message: v.message,
      stack: v.stack,
      ...('cause' in v ? {cause: errorOrObject(v.cause)} : null),
    };
  }
  if (v && typeof v === 'object') {
    return v;
  }
  return undefined;
}
