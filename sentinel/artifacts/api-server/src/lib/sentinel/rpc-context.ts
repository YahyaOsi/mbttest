import { AsyncLocalStorage } from "node:async_hooks";

type Task = { mission: "priority" | "background"; signal?: AbortSignal };
const tasks = new AsyncLocalStorage<Task>();
export const rpcTask = () => tasks.getStore();
export const withRpcMission = <T>(mission: Task["mission"], work: () => T, signal?: AbortSignal): T =>
  tasks.run({ mission, signal: signal ?? (tasks.getStore()?.mission === mission ? tasks.getStore()?.signal : undefined) }, work);

/** Bound optional evidence work, including transports that ignore abort.
 * A late result cannot authorize AI or retain an in-flight sweep lock. */
export async function boundedEvidence<T>(work: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      withRpcMission("background", work, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Optional AI evidence timed out")); }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
