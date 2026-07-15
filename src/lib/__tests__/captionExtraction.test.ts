import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractRecipeFromCaption,
  MIN_CAPTION_LENGTH,
} from "../socialImport/captionExtraction";
import { SocialImportError } from "../socialImport/types";

function mockOpenAIResponse(content: unknown) {
  return vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
  } as unknown as Response);
}

const usableCaption =
  "Garlic butter noodles! Ingredients: 8oz spaghetti, 4 tbsp butter, 6 garlic cloves, 2 tbsp soy sauce, parmesan. Boil pasta, brown the garlic in butter, toss with soy and cheese.";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractRecipeFromCaption", () => {
  it("skips the API call entirely for null captions", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const result = await extractRecipeFromCaption(null);
    expect(result).toEqual({ sufficient: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips the API call for captions below the length floor", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const result = await extractRecipeFromCaption(
      "x".repeat(MIN_CAPTION_LENGTH - 1)
    );
    expect(result).toEqual({ sufficient: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the normalized recipe when the model says sufficient", async () => {
    mockOpenAIResponse({
      sufficient: true,
      recipe: {
        title: "Garlic Butter Noodles",
        description: "Quick weeknight pasta",
        prepTime: 5,
        cookTime: 10,
        servings: 2,
        ingredients: [{ type: "item", text: "8oz spaghetti" }],
        instructions: [{ type: "item", text: "Boil pasta" }],
      },
    });

    const result = await extractRecipeFromCaption(usableCaption);
    expect(result.sufficient).toBe(true);
    if (result.sufficient) {
      expect(result.recipe.title).toBe("Garlic Butter Noodles");
      expect(result.recipe.description).toBe("Quick weeknight pasta");
      expect(result.recipe.ingredients).toHaveLength(1);
    }
  });

  it("returns insufficient when the model says so", async () => {
    mockOpenAIResponse({ sufficient: false, reason: "caption is a teaser" });
    const result = await extractRecipeFromCaption(usableCaption);
    expect(result).toEqual({ sufficient: false });
  });

  it("treats sufficient-but-empty extractions as insufficient", async () => {
    mockOpenAIResponse({
      sufficient: true,
      recipe: { title: "", ingredients: [], instructions: [] },
    });
    const result = await extractRecipeFromCaption(usableCaption);
    expect(result).toEqual({ sufficient: false });
  });

  it("throws INTERNAL on a non-OK OpenAI response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    await expect(extractRecipeFromCaption(usableCaption)).rejects.toThrowError(
      SocialImportError
    );
  });

  it("throws INTERNAL on malformed model JSON", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "not json {" } }],
      }),
    } as unknown as Response);

    await expect(extractRecipeFromCaption(usableCaption)).rejects.toThrowError(
      SocialImportError
    );
  });
});
