import util from "util";

const ALLOW_STDOUT_LOGS = process.env.SMART_CONTEXT_ALLOW_STDOUT_LOGS === "true";
const DEBUG_LOGS_ENABLED = process.env.SMART_CONTEXT_DEBUG === "true";

if (!ALLOW_STDOUT_LOGS) {
    const redirect = (level: "info" | "debug") => (...args: unknown[]) => {
        if (level === "debug" && !DEBUG_LOGS_ENABLED) {
            return;
        }
        const line = util.format(...args) + "\n";
        process.stderr.write(line);
    };

    console.log = redirect("info");
    console.info = redirect("info");
    console.debug = redirect("debug");
}
