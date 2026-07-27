import { AsyncLocalStorage } from "node:async_hooks";

// One trace id per investigation, carried implicitly down the async call tree so the SQS
// clients can stamp it on outbound requests without threading a parameter through
// LLMClient.chat() (which 3 implementations and 4 call sites would have to grow for a
// logging concern). The id is the Slack threadId, so a Slack permalink, the agent log and
// the llm-worker log all join on the same string.
const store = new AsyncLocalStorage<string>();

export const withTrace = <T>(traceId: string, fn: () => Promise<T>): Promise<T> => store.run(traceId, fn);

export const currentTrace = (): string | undefined => store.getStore();

// " trace=<id>" or "" — appended to log lines so a missing context adds no noise.
export const traceSuffix = (): string => {
  const id = store.getStore();
  return id ? ` trace=${id}` : "";
};
