const ENABLE_DEBUG_LOGS = process.env.SMART_CONTEXT_DEBUG === "true";
const ENV_LOG_LEVEL = (process.env.SMART_CONTEXT_LOG_LEVEL ?? "").toLowerCase();

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
    const levelPriority: Record<LogLevel, number> = {
        debug: 10,
        info: 20,
        warn: 30,
        error: 40
    };
    const configuredLevel = (ENV_LOG_LEVEL && Object.prototype.hasOwnProperty.call(levelPriority, ENV_LOG_LEVEL))
        ? (ENV_LOG_LEVEL as LogLevel)
        : (ENABLE_DEBUG_LOGS ? "debug" : "info");
    const log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
        if (levelPriority[level] < levelPriority[configuredLevel]) {
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
