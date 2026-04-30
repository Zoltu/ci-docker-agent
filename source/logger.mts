export type Log = (...data: unknown[]) => void

export function createLogger(): Log {
	return function log(...data: unknown[]): void {
		console.log(...data)
	}
}
