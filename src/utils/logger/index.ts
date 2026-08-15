import winston from "winston";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "prod" ? "info" : "debug"),
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }), // keep the stack when an Error is logged directly
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, stack }) =>
      `${timestamp} [${level}] ${message}${stack ? `\n${stack}` : ""}`)
  ),
  transports: [new winston.transports.Console()],
});

// `${err}` in a template literal prints only "Error: message" — the frames that say WHERE
// it broke are dropped, which is exactly what you need at 3am. err.stack already begins
// with "Error: message", so this is a drop-in replacement for `${err}` in log strings.
export const errDetail = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

export default logger;
