import { describe, expect, it } from "vitest";
import {
  ProfileValidationError,
  validateProfileInput,
} from "../profileValidation";

function expectValidationError(
  input: unknown,
  expectedMessage: string,
  options?: { allowAvatarUrl?: boolean }
) {
  try {
    validateProfileInput(input, options);
    throw new Error("Expected profile validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError);
    expect((error as ProfileValidationError).message).toBe(expectedMessage);
  }
}

describe("profile input validation", () => {
  it("normalizes valid profile values", () => {
    expect(
      validateProfileInput(
        {
          username: "  Test_User2 ",
          firstName: "  Alex ",
          lastName: " Korn ",
          bio: " Loves food ",
          avatarUrl: null,
        },
        { allowAvatarUrl: true }
      )
    ).toEqual({
      username: "test_user2",
      firstName: "Alex",
      lastName: "Korn",
      bio: "Loves food",
      avatarUrl: null,
    });
  });

  it("preserves omitted fields and converts empty optional text to null", () => {
    expect(validateProfileInput({ lastName: " ", bio: "" })).toEqual({
      lastName: null,
      bio: null,
    });
  });

  it.each([null, [], "profile", 42])(
    "rejects a non-object request body",
    (input) => {
      expectValidationError(input, "Request body must be a JSON object");
    }
  );

  it.each([
    ["username", 123],
    ["firstName", false],
    ["lastName", {}],
    ["bio", []],
  ])("rejects a non-string %s", (field, value) => {
    expectValidationError(
      { [field]: value },
      `${field} must be a string`
    );
  });

  it("rejects invalid avatar types", () => {
    expectValidationError(
      { avatarUrl: 123 },
      "avatarUrl must be a string or null",
      { allowAvatarUrl: true }
    );
  });

  it.each([
    ["username", "a".repeat(31), 30],
    ["firstName", "a".repeat(51), 50],
    ["lastName", "a".repeat(51), 50],
    ["bio", "a".repeat(161), 160],
  ])("enforces the %s character limit", (field, value, limit) => {
    expectValidationError(
      { [field]: value },
      `${field} must be ${limit} characters or fewer`
    );
  });

  it.each(["two words", "user-name", "user.name", "user@email"])(
    "rejects an invalid username: %s",
    (username) => {
      expectValidationError(
        { username },
        "username may only contain letters, numbers, and underscores"
      );
    }
  );

  it.each(["", "   "])("rejects an empty username", (username) => {
    expectValidationError({ username }, "username cannot be empty");
  });

  it("rejects an empty first name", () => {
    expectValidationError({ firstName: " " }, "firstName cannot be empty");
  });
});
