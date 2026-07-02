export const PROFILE_FIELD_LIMITS = {
  username: 30,
  firstName: 50,
  lastName: 50,
  bio: 160,
} as const;

const USERNAME_PATTERN = /^[a-z0-9_]+$/;

type ProfileField = keyof typeof PROFILE_FIELD_LIMITS | "avatarUrl";

export class ProfileValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: ProfileField
  ) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

export interface ValidatedProfileInput {
  username?: string;
  firstName?: string;
  lastName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}

function isRequestObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStringField(
  input: Record<string, unknown>,
  field: keyof typeof PROFILE_FIELD_LIMITS,
  options: { nullable: boolean; requiredValue: boolean }
): string | null | undefined {
  const value = input[field];
  if (value === undefined) return undefined;

  if (value === null) {
    if (options.nullable) return null;
    throw new ProfileValidationError(`${field} must be a string`, field);
  }

  if (typeof value !== "string") {
    throw new ProfileValidationError(`${field} must be a string`, field);
  }

  const limit = PROFILE_FIELD_LIMITS[field];
  if (value.length > limit) {
    throw new ProfileValidationError(
      `${field} must be ${limit} characters or fewer`,
      field
    );
  }

  const trimmedValue = value.trim();
  if (options.requiredValue && !trimmedValue) {
    throw new ProfileValidationError(`${field} cannot be empty`, field);
  }

  return trimmedValue || null;
}

export function validateProfileInput(
  value: unknown,
  options: { allowAvatarUrl?: boolean } = {}
): ValidatedProfileInput {
  if (!isRequestObject(value)) {
    throw new ProfileValidationError("Request body must be a JSON object");
  }

  const username = validateStringField(value, "username", {
    nullable: false,
    requiredValue: true,
  });
  const firstName = validateStringField(value, "firstName", {
    nullable: false,
    requiredValue: true,
  });
  const lastName = validateStringField(value, "lastName", {
    nullable: true,
    requiredValue: false,
  });
  const bio = validateStringField(value, "bio", {
    nullable: true,
    requiredValue: false,
  });

  const result: ValidatedProfileInput = {};

  if (username !== undefined) {
    const normalizedUsername = username!.toLowerCase();
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      throw new ProfileValidationError(
        "username may only contain letters, numbers, and underscores",
        "username"
      );
    }
    result.username = normalizedUsername;
  }
  if (firstName !== undefined) result.firstName = firstName!;
  if (lastName !== undefined) result.lastName = lastName;
  if (bio !== undefined) result.bio = bio;

  if (options.allowAvatarUrl && value.avatarUrl !== undefined) {
    if (value.avatarUrl !== null && typeof value.avatarUrl !== "string") {
      throw new ProfileValidationError(
        "avatarUrl must be a string or null",
        "avatarUrl"
      );
    }
    result.avatarUrl = value.avatarUrl as string | null;
  }

  return result;
}
