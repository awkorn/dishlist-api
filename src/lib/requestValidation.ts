type ValidationResult<T> =
  | { value: T; error?: never }
  | { value?: never; error: string };

export function validateRequiredText(
  value: unknown,
  options: {
    field: string;
    minLength?: number;
    maxLength: number;
  },
): ValidationResult<string> {
  if (typeof value !== "string" || !value.trim()) {
    return { error: `${options.field} is required` };
  }

  const normalized = value.trim();

  if (
    options.minLength !== undefined &&
    normalized.length < options.minLength
  ) {
    return {
      error: `${options.field} must be at least ${options.minLength} characters`,
    };
  }

  if (normalized.length > options.maxLength) {
    return {
      error: `${options.field} must be ${options.maxLength} characters or less`,
    };
  }

  return { value: normalized };
}

export function validateOptionalText(
  value: unknown,
  options: {
    field: string;
    maxLength: number;
  },
): ValidationResult<string | null> {
  if (value === undefined || value === null || value === "") {
    return { value: null };
  }

  if (typeof value !== "string") {
    return { error: `${options.field} must be a string` };
  }

  const normalized = value.trim();
  if (!normalized) {
    return { value: null };
  }

  if (normalized.length > options.maxLength) {
    return {
      error: `${options.field} must be ${options.maxLength} characters or less`,
    };
  }

  return { value: normalized };
}

export function validateOptionalEnum<T extends string>(
  value: unknown,
  options: {
    field: string;
    allowedValues: readonly T[];
    defaultValue: T;
  },
): ValidationResult<T> {
  if (value === undefined) {
    return { value: options.defaultValue };
  }

  if (
    typeof value !== "string" ||
    !options.allowedValues.includes(value as T)
  ) {
    return {
      error: `${options.field} must be one of: ${options.allowedValues.join(", ")}`,
    };
  }

  return { value: value as T };
}
