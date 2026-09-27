import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a piece of work belongs to, available anywhere down the call stack.
 *
 * Usage metering happens deep inside the LLM client, which has no idea which
 * user or interview it is serving. Threading that through every call signature
 * would touch a dozen files for one accounting feature; the auth guard and the
 * voice session set it once instead.
 */
export interface WorkContext {
  userId?: string;
  interviewId?: string;
}

const storage = new AsyncLocalStorage<WorkContext>();

export const runWithContext = <T>(ctx: WorkContext, fn: () => T): T => storage.run(ctx, fn);

export const currentContext = (): WorkContext => storage.getStore() ?? {};
