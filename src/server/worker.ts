import {
  LogContext,
  Logger,
  LogLevel,
  OptionalLoggerImpl,
} from "../util/logger";
import { randomID } from "../util/rand";

export interface WorkerOptions<Env extends BaseWorkerEnv> {
  createLogger: (env: Env) => Logger;
  getLogLevel: (env: Env) => LogLevel;
}

export interface BaseWorkerEnv {
  authDO: DurableObjectNamespace;
}

export function createWorker<Env extends BaseWorkerEnv>(
  options: WorkerOptions<Env>
): ExportedHandler<Env> {
  const { createLogger, getLogLevel } = options;
  return {
    fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
      return await fetch(request, env, ctx, createLogger, getLogLevel);
    },
  };
}

async function fetch<Env extends BaseWorkerEnv>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  createLogger: (env: Env) => Logger,
  getLogLevel: (env: Env) => LogLevel
) {
  const logger = createLogger(env);
  const optionalLogger = new OptionalLoggerImpl(logger, getLogLevel(env));
  // TODO: pass request id through so request can be traced across
  // worker and DOs.
  const lc = new LogContext(optionalLogger)
    .addContext("Worker")
    .addContext("req", randomID());
  lc.debug?.("Handling request:", request.url);
  try {
    const resp = await handleRequest(request, lc, env);
    lc.debug?.(`Returning response: ${resp.status} ${resp.statusText}`);
    return resp;
  } catch (e) {
    lc.info?.("Unhandled exception", e);
    throw e;
  } finally {
    if (logger.flush) {
      ctx.waitUntil(logger.flush());
    }
  }
}

async function handleRequest(
  request: Request,
  lc: LogContext,
  env: BaseWorkerEnv
): Promise<Response> {
  // Match route against pattern /:name/*action
  const url = new URL(request.url);

  switch (url.pathname) {
    case "/connect":
      lc.debug?.("Handling connect.");
      return forwardToAuthServer(request, env);
    default:
      return new Response("unknown route", {
        status: 400,
      });
  }
}

async function forwardToAuthServer(
  request: Request,
  env: BaseWorkerEnv
): Promise<Response> {
  const { authDO } = env;
  const id = authDO.idFromName("auth");
  const stub = authDO.get(id);
  return stub.fetch(request);
}
