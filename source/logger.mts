export interface Logger {
	log: (...data: unknown[]) => void
}

export const createLogger = (): Logger => ({ log: console.log })
