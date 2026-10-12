export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Parses an optional boolean environment variable. Accepts true/false and 1/0
 * (case-insensitive); unset or empty means false.
 */
export function parseBooleanEnv(name: string, value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "" || normalized === "false" || normalized === "0") {
    return false;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  throw new ConfigError(`${name} must be true or false, got "${value}"`);
}
