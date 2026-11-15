export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export const logger: Logger = {
  info: (message, details) => console.log(JSON.stringify({ level: "info", message, ...details })),
  warn: (message, details) => console.warn(JSON.stringify({ level: "warn", message, ...details })),
  error: (message, details) => console.error(JSON.stringify({ level: "error", message, ...details })),
};
