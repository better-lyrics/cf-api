export function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function isTruthy(value: string | null | undefined): boolean {
    return !(value === null || value === undefined);
}
