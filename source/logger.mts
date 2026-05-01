export interface Logger {
	log: (...data: unknown[]) => void
}

export function createLogger(): Logger {
	return {
		log: (...data: unknown[]): void => { console.log(...data) },
	}
}
