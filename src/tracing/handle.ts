// The SDK handle, in a module that imports nothing: the agent imports activeTracing() from here, so
// with tracing off not one OpenTelemetry module is loaded. index.ts (the SDK) sets it.

export interface TracingHandle {
  shutdown(): Promise<void>;
}

let active: TracingHandle | null = null;

/** The SDK the preload started, for the service's shutdown to flush; null when it did not start. */
export function activeTracing(): TracingHandle | null {
  return active;
}

export function setActiveTracing(h: TracingHandle | null): void {
  active = h;
}
