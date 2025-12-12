const ENABLE_DEBUG_LOGS = process.env.SMART_CONTEXT_DEBUG === "true";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
    const log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
        if (level === "debug" && !ENABLE_DEBUG_LOGS) {
            return;
        }
        const payload = {
            timestamp: new Date().toISOString(),
            level,
            component,
            message,
            ...(fields ?? {})
        };
        const sink = level === "error" ? console.error
            : level === "warn" ? console.warn
            : level === "debug" ? console.debug
            : console.info;
        sink(payload);
    };

    return {
        debug: (message, fields) => log("debug", message, fields),
        info: (message, fields) => log("info", message, fields),
        warn: (message, fields) => log("warn", message, fields),
        error: (message, fields) => log("error", message, fields)
    };
}

