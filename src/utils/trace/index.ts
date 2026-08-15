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

// Workload class for the LLM router, carried the same way and for the same reason as the
// trace id above: adding a parameter to LLMClient.chat() would grow 3 implementations and
// every call site for a concern none of them own. `escalated` is mutable on purpose — once
// one call in an investigation falls up to the heavy tier, the rest skip the light tier
// instead of paying a failed attempt per round.
export type LlmRoute = "heavy" | "light";

export interface RouteContext {
  route: LlmRoute;
  escalated: boolean;
}

const routeStore = new AsyncLocalStorage<RouteContext>();

export const withRoute = <T>(route: LlmRoute, fn: () => Promise<T>): Promise<T> =>
  routeStore.run({ route, escalated: false }, fn);

export const currentRouteContext = (): RouteContext | undefined => routeStore.getStore();
