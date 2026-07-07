import { describe, expect, it } from "vitest";
import {
  normalizeRecipeImages,
  normalizeRecipeNotes,
  validateRecipeItemLimits,
  validateRecipeNumericFields,
  validateNutritionField,
  validateNutritionRequest,
  validateImportImages,
  normalizeImportedRecipe,
  getImportWarnings,
  MAX_RECIPE_IMAGES,
  MAX_RECIPE_ITEMS,
  MAX_RECIPE_ITEM_LENGTH,
  MAX_RECIPE_NOTES,
  MAX_RECIPE_NOTE_LENGTH,
  MAX_PREP_COOK_MINUTES,
  MAX_SERVINGS,
  MAX_NUTRITION_INGREDIENTS,
  MAX_NUTRITION_INGREDIENT_LENGTH,
  MAX_NUTRITION_SERVINGS,
  MAX_IMPORT_IMAGES,
  MAX_IMPORT_IMAGE_BASE64_LENGTH,
} from "../recipeValidation";

describe("normalizeRecipeImages", () => {
  it("prefers imageUrls and trims/drops empty entries", () => {
    const result = normalizeRecipeImages(["  a  ", "", "b"], undefined);
    expect(result.error).toBeUndefined();
    expect(result.urls).toEqual(["a", "b"]);
  });

  it("falls back to a single imageUrl when imageUrls is absent", () => {
    const result = normalizeRecipeImages(undefined, "  solo  ");
    expect(result.urls).toEqual(["solo"]);
  });

  it("returns [] when neither is provided", () => {
    expect(normalizeRecipeImages(undefined, undefined).urls).toEqual([]);
  });

  it("rejects a non-array imageUrls", () => {
    expect(normalizeRecipeImages("nope", undefined).error).toBe(
      "imageUrls must be an array"
    );
  });

  it("rejects too many images", () => {
    const many = Array(MAX_RECIPE_IMAGES + 1).fill("x");
    expect(normalizeRecipeImages(many, undefined).error).toMatch(/Maximum/);
  });

  it("rejects non-string entries", () => {
    expect(normalizeRecipeImages([123], undefined).error).toBe(
      "Each image URL must be a string"
    );
  });
});

describe("normalizeRecipeNotes", () => {
  it("returns [] for null/undefined", () => {
    expect(normalizeRecipeNotes(undefined).notes).toEqual([]);
    expect(normalizeRecipeNotes(null).notes).toEqual([]);
  });

  it("trims and drops empty notes", () => {
    expect(normalizeRecipeNotes(["  a ", "", "b"]).notes).toEqual(["a", "b"]);
  });

  it("rejects a non-array", () => {
    expect(normalizeRecipeNotes("nope").error).toBe("notes must be an array");
  });

  it("rejects non-string entries", () => {
    expect(normalizeRecipeNotes([1]).error).toBe("Each note must be a string");
  });

  it("rejects too many notes", () => {
    const many = Array(MAX_RECIPE_NOTES + 1).fill("x");
    expect(normalizeRecipeNotes(many).error).toMatch(/at most/);
  });

  it("rejects an over-long note", () => {
    const long = "a".repeat(MAX_RECIPE_NOTE_LENGTH + 1);
    expect(normalizeRecipeNotes([long]).error).toMatch(/characters or less/);
  });
});

describe("validateRecipeItemLimits", () => {
  it("passes a reasonable list", () => {
    expect(
      validateRecipeItemLimits(
        [{ type: "item", text: "flour" }],
        "ingredients"
      )
    ).toBeNull();
  });

  it("ignores non-arrays (structure check handles them)", () => {
    expect(validateRecipeItemLimits("nope", "ingredients")).toBeNull();
  });

  it("rejects too many items", () => {
    const many = Array(MAX_RECIPE_ITEMS + 1).fill({ type: "item", text: "x" });
    expect(validateRecipeItemLimits(many, "ingredients")).toMatch(
      /more than/
    );
  });

  it("rejects an over-long item text", () => {
    const long = "a".repeat(MAX_RECIPE_ITEM_LENGTH + 1);
    expect(
      validateRecipeItemLimits([{ type: "item", text: long }], "instructions")
    ).toMatch(/characters or less/);
  });
});

describe("validateRecipeNumericFields", () => {
  it("passes absent values through as null", () => {
    const result = validateRecipeNumericFields({});
    expect(result.ok && result.value).toEqual({
      prepTime: null,
      cookTime: null,
      servings: null,
    });
  });

  it("accepts valid integers", () => {
    const result = validateRecipeNumericFields({
      prepTime: 10,
      cookTime: 20,
      servings: 4,
    });
    expect(result.ok && result.value).toEqual({
      prepTime: 10,
      cookTime: 20,
      servings: 4,
    });
  });

  it("rejects a non-numeric prepTime", () => {
    const result = validateRecipeNumericFields({ prepTime: "10" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/whole number/);
  });

  it("rejects a non-integer", () => {
    const result = validateRecipeNumericFields({ cookTime: 1.5 });
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(
      validateRecipeNumericFields({ prepTime: MAX_PREP_COOK_MINUTES + 1 }).ok
    ).toBe(false);
    expect(validateRecipeNumericFields({ servings: 0 }).ok).toBe(false);
    expect(validateRecipeNumericFields({ servings: MAX_SERVINGS + 1 }).ok).toBe(
      false
    );
  });
});

describe("validateNutritionField", () => {
  it("passes null/undefined through", () => {
    expect(validateNutritionField(undefined)).toEqual({
      ok: true,
      value: null,
    });
    expect(validateNutritionField(null)).toEqual({ ok: true, value: null });
  });

  it("keeps only known numeric keys", () => {
    const result = validateNutritionField({
      calories: 100,
      protein: 5,
      bogus: 9,
    });
    expect(result.ok && result.value).toEqual({ calories: 100, protein: 5 });
  });

  it("rejects arrays and non-objects", () => {
    expect(validateNutritionField([]).ok).toBe(false);
    expect(validateNutritionField("nope").ok).toBe(false);
  });

  it("rejects a negative or non-numeric value", () => {
    expect(validateNutritionField({ calories: -1 }).ok).toBe(false);
    expect(validateNutritionField({ fat: "lots" }).ok).toBe(false);
  });
});

describe("validateNutritionRequest", () => {
  it("accepts a valid request and trims ingredients", () => {
    const result = validateNutritionRequest(["  flour ", "eggs"], 4);
    expect(result.ok && result.value).toEqual({
      ingredients: ["flour", "eggs"],
      servings: 4,
    });
  });

  it("rejects an empty or non-array ingredients list", () => {
    expect(validateNutritionRequest([], 4).ok).toBe(false);
    expect(validateNutritionRequest("nope", 4).ok).toBe(false);
  });

  it("rejects non-string ingredient entries", () => {
    expect(validateNutritionRequest([{}], 4).ok).toBe(false);
  });

  it("rejects too many ingredients", () => {
    const many = Array(MAX_NUTRITION_INGREDIENTS + 1).fill("x");
    expect(validateNutritionRequest(many, 4).ok).toBe(false);
  });

  it("rejects an over-long ingredient", () => {
    const long = "a".repeat(MAX_NUTRITION_INGREDIENT_LENGTH + 1);
    expect(validateNutritionRequest([long], 4).ok).toBe(false);
  });

  it("rejects bad servings", () => {
    expect(validateNutritionRequest(["flour"], 0).ok).toBe(false);
    expect(validateNutritionRequest(["flour"], 1.5).ok).toBe(false);
    expect(
      validateNutritionRequest(["flour"], MAX_NUTRITION_SERVINGS + 1).ok
    ).toBe(false);
    expect(validateNutritionRequest(["flour"], "4").ok).toBe(false);
  });
});

describe("validateImportImages", () => {
  const valid = { base64: "abc123", mimeType: "image/jpeg" };

  it("accepts a valid image list", () => {
    const result = validateImportImages([valid]);
    expect(result.ok && result.value).toEqual([valid]);
  });

  it("rejects empty / non-array input", () => {
    expect(validateImportImages([]).ok).toBe(false);
    expect(validateImportImages(undefined).ok).toBe(false);
  });

  it("rejects too many images", () => {
    const many = Array(MAX_IMPORT_IMAGES + 1).fill(valid);
    expect(validateImportImages(many).ok).toBe(false);
  });

  it("rejects missing base64/mimeType", () => {
    expect(validateImportImages([{ base64: "abc" }]).ok).toBe(false);
    expect(validateImportImages([{ mimeType: "image/png" }]).ok).toBe(false);
  });

  it("rejects a disallowed mimeType", () => {
    expect(
      validateImportImages([{ base64: "abc", mimeType: "image/svg+xml" }]).ok
    ).toBe(false);
  });

  it("rejects an oversized image", () => {
    const big = {
      base64: "a".repeat(MAX_IMPORT_IMAGE_BASE64_LENGTH + 1),
      mimeType: "image/jpeg",
    };
    expect(validateImportImages([big]).ok).toBe(false);
  });
});

describe("normalizeImportedRecipe + getImportWarnings", () => {
  it("normalizes a full payload with no warnings", () => {
    const recipe = normalizeImportedRecipe({
      title: "Soup",
      prepTime: 5,
      cookTime: 10,
      servings: 2,
      ingredients: [{ type: "item", text: "water" }],
      instructions: [{ type: "item", text: "boil" }],
    });
    expect(recipe.title).toBe("Soup");
    expect(getImportWarnings(recipe)).toEqual([]);
  });

  it("coerces bad types and reports warnings", () => {
    const recipe = normalizeImportedRecipe({
      title: 123,
      prepTime: "5",
      ingredients: "nope",
      instructions: null,
    });
    expect(recipe.title).toBe("");
    expect(recipe.prepTime).toBeNull();
    expect(recipe.ingredients).toEqual([]);
    expect(recipe.instructions).toEqual([]);
    const warnings = getImportWarnings(recipe);
    expect(warnings).toContain("Could not extract recipe title");
    expect(warnings).toContain("Could not extract ingredients");
    expect(warnings).toContain("Could not extract instructions");
    expect(warnings).toContain("Could not extract cooking times");
    expect(warnings).toContain("Could not extract serving size");
  });

  it("handles a null/garbage payload", () => {
    const recipe = normalizeImportedRecipe(null);
    expect(recipe.ingredients).toEqual([]);
    expect(getImportWarnings(recipe).length).toBeGreaterThan(0);
  });
});
