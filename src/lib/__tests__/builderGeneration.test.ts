import { describe, expect, it } from "vitest";
import {
  validateBuilderInput,
  normalizeRecipes,
  extractMessageContent,
  BuilderValidationError,
  MAX_PROMPT_LENGTH,
  MAX_HISTORY_TURNS,
  MAX_PREFERENCES,
  MAX_RECIPES,
} from "../builderGeneration";

describe("validateBuilderInput", () => {
  it("accepts and trims a valid prompt", () => {
    const result = validateBuilderInput({ prompt: "  make tacos  " });
    expect(result.prompt).toBe("make tacos");
    expect(result.history).toEqual([]);
    expect(result.preferences).toEqual([]);
  });

  it("rejects missing or empty prompts", () => {
    expect(() => validateBuilderInput({})).toThrow(BuilderValidationError);
    expect(() => validateBuilderInput({ prompt: "   " })).toThrow(
      "A prompt is required"
    );
    expect(() => validateBuilderInput(null)).toThrow(BuilderValidationError);
  });

  it("rejects an over-long prompt", () => {
    const prompt = "a".repeat(MAX_PROMPT_LENGTH + 1);
    expect(() => validateBuilderInput({ prompt })).toThrow(
      `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer`
    );
  });

  it("trims history to the most recent MAX_HISTORY_TURNS and drops bad entries", () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 4 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    }));
    history.push({ role: "system" as any, content: "ignore me" });
    history.push({ role: "user", content: 123 as any });

    const result = validateBuilderInput({ prompt: "hi", history });
    expect(result.history).toHaveLength(MAX_HISTORY_TURNS);
    // keeps the tail of the valid entries
    expect(result.history[result.history.length - 1].content).toBe(
      `msg ${MAX_HISTORY_TURNS + 3}`
    );
    expect(result.history.every((m) => m.role === "user" || m.role === "assistant")).toBe(
      true
    );
  });

  it("caps and cleans preferences", () => {
    const preferences = [
      ...Array.from({ length: MAX_PREFERENCES + 5 }, (_, i) => `pref ${i}`),
      "   ",
      42 as any,
    ];
    const result = validateBuilderInput({ prompt: "hi", preferences });
    expect(result.preferences).toHaveLength(MAX_PREFERENCES);
    expect(result.preferences).not.toContain("");
  });
});

describe("normalizeRecipes", () => {
  it("returns null when recipes is not an array", () => {
    expect(normalizeRecipes({})).toBeNull();
    expect(normalizeRecipes({ recipes: "nope" })).toBeNull();
    expect(normalizeRecipes(null)).toBeNull();
  });

  it("caps to MAX_RECIPES and fills defaults for missing fields", () => {
    const parsed = {
      recipes: Array.from({ length: MAX_RECIPES + 3 }, () => ({})),
    };
    const recipes = normalizeRecipes(parsed)!;
    expect(recipes).toHaveLength(MAX_RECIPES);
    expect(recipes[0]).toMatchObject({
      title: "Untitled Recipe",
      prepTime: null,
      cookTime: null,
      servings: null,
      ingredients: [],
      instructions: [],
    });
  });

  it("normalizes ingredient/instruction line types and drops generated tags", () => {
    const recipes = normalizeRecipes({
      recipes: [
        {
          title: "Soup",
          ingredients: [
            { type: "header", text: "For the broth" },
            { type: "weird", text: "water" },
            { text: "salt" },
          ],
          instructions: [{ type: "item", text: "Boil" }],
          tags: ["dinner", 5],
        },
      ],
    })!;
    expect(recipes[0].ingredients).toEqual([
      { type: "header", text: "For the broth" },
      { type: "item", text: "water" },
      { type: "item", text: "salt" },
    ]);
    expect(recipes[0]).not.toHaveProperty("tags");
  });
});

describe("extractMessageContent", () => {
  it("returns the content string when present", () => {
    expect(
      extractMessageContent({ choices: [{ message: { content: "{}" } }] })
    ).toBe("{}");
  });

  it("returns null for empty or malformed responses", () => {
    expect(extractMessageContent({ choices: [] })).toBeNull();
    expect(extractMessageContent({})).toBeNull();
    expect(extractMessageContent(null)).toBeNull();
    expect(
      extractMessageContent({ choices: [{ message: { content: null } }] })
    ).toBeNull();
  });
});
