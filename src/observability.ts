export let awaitLists = new Set<Promise<any>>();

let observabilityData: Record<string, any[]> = {};

export function observe(data: Record<string, any>): void {
    for (const key in data) {
        const value = data[key];
        if (!observabilityData[key]) {
            observabilityData[key] = [];
        }
        observabilityData[key].push(value);
    }
}

export function resetObservability(): void {
    observabilityData = {};
    awaitLists = new Set<Promise<any>>();
}

export function getObservabilityData(): Record<string, any[]> {
    return observabilityData;
}

export async function flushObservability(): Promise<void> {
    await Promise.all(Array.from(awaitLists))
        .catch((err: Error) => {
            console.error(err, err.stack);
        });
    try {
        console.log(observabilityData);
    } catch (e) {
        console.error("Failed to write obs data", e);
    }
}
