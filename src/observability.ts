import { AsyncLocalStorage } from 'node:async_hooks';

interface ObservabilityStore {
    data: Record<string, any[]>;
    awaitLists: Set<Promise<any>>;
}

const als = new AsyncLocalStorage<ObservabilityStore>();

export function runWithObservability<T>(callback: () => T): T {
    const store: ObservabilityStore = {
        data: {},
        awaitLists: new Set<Promise<any>>()
    };
    return als.run(store, callback);
}

export function observe(data: Record<string, any>): void {
    const store = als.getStore();
    if (!store) {
        // Fallback for when running outside of request context (shouldn't happen in production paths)
        console.warn("Observability called outside of context", data);
        return;
    }

    for (const key in data) {
        const value = data[key];
        if (!store.data[key]) {
            store.data[key] = [];
        }
        store.data[key].push(value);
    }
}

export function addAwait(promise: Promise<any>): void {
    const store = als.getStore();
    if (store) {
        store.awaitLists.add(promise);
    } else {
         console.warn("addAwait called outside of context");
         // We can't really track it, but we should at least not crash.
         // Maybe just let it float.
    }
}

export function getObservabilityData(): Record<string, any[]> {
    const store = als.getStore();
    return store ? store.data : {};
}

export async function flushObservability(): Promise<void> {
    const store = als.getStore();
    if (!store) return;

    await Promise.all(Array.from(store.awaitLists))
        .catch((err: Error) => {
            console.error(err, err.stack);
        });
    try {
        console.log(JSON.stringify(store.data));
    } catch (e) {
        console.error("Failed to write obs data", e);
    }
}

// Deprecated/No-op functions to maintain compatibility during refactor if needed, 
// but we will update callers.
export function resetObservability(): void {
    // No-op, managed by runWithObservability
}