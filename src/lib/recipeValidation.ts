// Pure, side-effect-free helpers for the recipe + nutrition + import endpoints:
// image/note shape normalization, numeric/JSON field validation, item-limit
// caps, import-image request validation, and import-response normalization.
// Kept dependency-free so they can be unit tested directly (see
// __tests__/recipeValidation.test.ts). The route handlers do the DB/network work
// and translate a returned rejection into an HTTP response.

// ─── Recipe field caps ──────────────────────────────────────────────
export const MAX_RECIPE_IMAGES = 4;
export const MAX_RECIPE_TITLE_LENGTH = 100;
export const MAX_RECIPE_DESCRIPTION_LENGTH = 1000;
export const MAX_RECIPE_ITEMS = 200; // per ingredients / instructions list
export const MAX_RECIPE_ITEM_LENGTH = 500;
export const MAX_RECIPE_NOTES = 20;
export const MAX_RECIPE_NOTE_LENGTH = 1000;
export const MAX_PREP_COOK_MINUTES = 6000; // 100 hours — generous upper bound
export const MAX_SERVINGS = 1000;

// ─── Nutrition request caps ─────────────────────────────────────────
export const MAX_NUTRITION_INGREDIENTS = 100;
export const MAX_NUTRITION_INGREDIENT_LENGTH = 300;
export const MAX_NUTRITION_SERVINGS = 100;
export const NUTRITION_KEYS = [
  "calories",
  "protein",
  "carbs",
  "sugar",
  "fat",
] as const;

// ─── Import (GPT-4 Vision) request caps ─────────────────────────────
export const MAX_IMPORT_IMAGES = 5;
export const ALLOWED_IMPORT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
];
// ~2MB decoded per image. base64 inflates by 4/3, so cap the string length at
// the equivalent number of characters. A backstop behind the global 10mb body
// limit and the client-side downscale.
export const MAX_IMPORT_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_IMAGE_BASE64_LENGTH = Math.ceil(
  (MAX_IMPORT_IMAGE_BYTES * 4) / 3
);

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ─── Image URL shape normalization (moved from routes/recipe.ts) ────
export function normalizeRecipeImages(
  imageUrls: unknown,
  imageUrl: unknown
): { urls?: string[]; error?: string } {
  const rawUrls =
    imageUrls !== undefined
      ? imageUrls
      : typeof imageUrl === "string" && imageUrl.trim()
        ? [imageUrl]
        : [];

  if (!Array.isArray(rawUrls)) {
    return { error: "imageUrls must be an array" };
  }

  if (rawUrls.length > MAX_RECIPE_IMAGES) {
    return { error: `Maximum ${MAX_RECIPE_IMAGES} images allowed` };
  }

  const urls: string[] = [];
  for (const rawUrl of rawUrls) {
    if (typeof rawUrl !== "string") {
      return { error: "Each image URL must be a string" };
    }

    const trimmedUrl = rawUrl.trim();
    if (trimmedUrl) {
      urls.push(trimmedUrl);
    }
  }

  return { urls };
}

// ─── Notes shape + limits (moved from routes/recipe.ts, caps added) ─
export function normalizeRecipeNotes(
  notes: unknown
): { notes?: string[]; error?: string } {
  if (notes === undefined || notes === null) {
    return { notes: [] };
  }

  if (!Array.isArray(notes)) {
    return { error: "notes must be an array" };
  }

  if (notes.length > MAX_RECIPE_NOTES) {
    return { error: `A recipe can have at most ${MAX_RECIPE_NOTES} notes` };
  }

  const normalizedNotes: string[] = [];
  for (const note of notes) {
    if (typeof note !== "string") {
      return { error: "Each note must be a string" };
    }

    const trimmedNote = note.trim();
    if (trimmedNote.length > MAX_RECIPE_NOTE_LENGTH) {
      return {
        error: `Each note must be ${MAX_RECIPE_NOTE_LENGTH} characters or less`,
      };
    }
    if (trimmedNote) {
      normalizedNotes.push(trimmedNote);
    }
  }

  return { notes: normalizedNotes };
}

/**
 * Enforce count + per-item text-length caps on a recipe items list. Runs after
 * validateRecipeItems (which checks structure); returns an error string or null.
 */
export function validateRecipeItemLimits(
  items: unknown,
  fieldName: string
): string | null {
  if (!Array.isArray(items)) {
    // Structure validation handles the non-array case; nothing to cap.
    return null;
  }

  if (items.length > MAX_RECIPE_ITEMS) {
    return `${fieldName} cannot have more than ${MAX_RECIPE_ITEMS} entries`;
  }

  for (const item of items) {
    const text = (item as { text?: unknown })?.text;
    if (typeof text === "string" && text.length > MAX_RECIPE_ITEM_LENGTH) {
      return `Each ${fieldName.slice(0, -1)} must be ${MAX_RECIPE_ITEM_LENGTH} characters or less`;
    }
  }

  return null;
}

/**
 * Validate optional prep/cook time (minutes) and servings. Absent/null values
 * pass through as null; present values must be non-negative integers within
 * bounds. Returns the coerced trio or an error.
 */
export function validateRecipeNumericFields(body: {
  prepTime?: unknown;
  cookTime?: unknown;
  servings?: unknown;
}): ValidationResult<{
  prepTime: number | null;
  cookTime: number | null;
  servings: number | null;
}> {
  const prep = validateOptionalInt(body.prepTime, {
    field: "Prep time",
    min: 0,
    max: MAX_PREP_COOK_MINUTES,
  });
  if (!prep.ok) return prep;

  const cook = validateOptionalInt(body.cookTime, {
    field: "Cook time",
    min: 0,
    max: MAX_PREP_COOK_MINUTES,
  });
  if (!cook.ok) return cook;

  const servings = validateOptionalInt(body.servings, {
    field: "Servings",
    min: 1,
    max: MAX_SERVINGS,
  });
  if (!servings.ok) return servings;

  return {
    ok: true,
    value: {
      prepTime: prep.value,
      cookTime: cook.value,
      servings: servings.value,
    },
  };
}

function validateOptionalInt(
  value: unknown,
  opts: { field: string; min: number; max: number }
): ValidationResult<number | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return { ok: false, error: `${opts.field} must be a whole number` };
  }
  if (value < opts.min || value > opts.max) {
    return {
      ok: false,
      error: `${opts.field} must be between ${opts.min} and ${opts.max}`,
    };
  }
  return { ok: true, value };
}

/**
 * Validate the optional nutrition blob. Absent/null → null. Otherwise it must be
 * a plain object whose known keys are finite non-negative numbers; unknown keys
 * are dropped. Returns a clean object (only NUTRITION_KEYS) or an error.
 */
export function validateNutritionField(
  nutrition: unknown
): ValidationResult<Record<string, number> | null> {
  if (nutrition === undefined || nutrition === null) {
    return { ok: true, value: null };
  }

  if (typeof nutrition !== "object" || Array.isArray(nutrition)) {
    return { ok: false, error: "nutrition must be an object" };
  }

  const source = nutrition as Record<string, unknown>;
  const clean: Record<string, number> = {};
  for (const key of NUTRITION_KEYS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return { ok: false, error: `nutrition.${key} must be a positive number` };
    }
    clean[key] = raw;
  }

  return { ok: true, value: clean };
}

// ─── Nutrition request validation (routes/nutrition.ts) ─────────────
export function validateNutritionRequest(
  ingredients: unknown,
  servings: unknown
): ValidationResult<{ ingredients: string[]; servings: number }> {
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return { ok: false, error: "Ingredients array is required" };
  }

  if (ingredients.length > MAX_NUTRITION_INGREDIENTS) {
    return {
      ok: false,
      error: `A recipe can have at most ${MAX_NUTRITION_INGREDIENTS} ingredients`,
    };
  }

  const cleaned: string[] = [];
  for (const ingredient of ingredients) {
    if (typeof ingredient !== "string" || !ingredient.trim()) {
      return { ok: false, error: "Each ingredient must be a non-empty string" };
    }
    const trimmed = ingredient.trim();
    if (trimmed.length > MAX_NUTRITION_INGREDIENT_LENGTH) {
      return {
        ok: false,
        error: `Each ingredient must be ${MAX_NUTRITION_INGREDIENT_LENGTH} characters or less`,
      };
    }
    cleaned.push(trimmed);
  }

  if (
    typeof servings !== "number" ||
    !Number.isFinite(servings) ||
    !Number.isInteger(servings) ||
    servings < 1 ||
    servings > MAX_NUTRITION_SERVINGS
  ) {
    return {
      ok: false,
      error: `Servings must be a whole number between 1 and ${MAX_NUTRITION_SERVINGS}`,
    };
  }

  return { ok: true, value: { ingredients: cleaned, servings } };
}

// ─── Import-from-images request validation (routes/recipe.ts) ───────
export interface ImportImage {
  base64: string;
  mimeType: string;
}

export function validateImportImages(
  raw: unknown
): ValidationResult<ImportImage[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "At least one image is required" };
  }

  if (raw.length > MAX_IMPORT_IMAGES) {
    return { ok: false, error: `Maximum ${MAX_IMPORT_IMAGES} images allowed` };
  }

  const images: ImportImage[] = [];
  for (const img of raw) {
    const candidate = img as { base64?: unknown; mimeType?: unknown };
    if (
      typeof candidate?.base64 !== "string" ||
      !candidate.base64 ||
      typeof candidate?.mimeType !== "string" ||
      !candidate.mimeType
    ) {
      return {
        ok: false,
        error: "Each image must have base64 and mimeType properties",
      };
    }

    if (!ALLOWED_IMPORT_MIME_TYPES.includes(candidate.mimeType.toLowerCase())) {
      return { ok: false, error: "Unsupported image type" };
    }

    if (candidate.base64.length > MAX_IMPORT_IMAGE_BASE64_LENGTH) {
      return {
        ok: false,
        error: "Each image must be 2MB or smaller",
      };
    }

    images.push({ base64: candidate.base64, mimeType: candidate.mimeType });
  }

  return { ok: true, value: images };
}

// ─── Import response normalization (moved from routes/recipe.ts) ────
export interface NormalizedImportedRecipe {
  title: string;
  prepTime: number | null;
  cookTime: number | null;
  servings: number | null;
  ingredients: unknown[];
  instructions: unknown[];
}

export function normalizeImportedRecipe(
  extracted: unknown
): NormalizedImportedRecipe {
  const source = (extracted ?? {}) as Record<string, unknown>;
  return {
    title: typeof source.title === "string" ? source.title : "",
    prepTime: typeof source.prepTime === "number" ? source.prepTime : null,
    cookTime: typeof source.cookTime === "number" ? source.cookTime : null,
    servings: typeof source.servings === "number" ? source.servings : null,
    ingredients: Array.isArray(source.ingredients) ? source.ingredients : [],
    instructions: Array.isArray(source.instructions) ? source.instructions : [],
  };
}

export function getImportWarnings(recipe: NormalizedImportedRecipe): string[] {
  const warnings: string[] = [];
  if (!recipe.title) warnings.push("Could not extract recipe title");
  if (recipe.ingredients.length === 0)
    warnings.push("Could not extract ingredients");
  if (recipe.instructions.length === 0)
    warnings.push("Could not extract instructions");
  if (recipe.prepTime === null && recipe.cookTime === null) {
    warnings.push("Could not extract cooking times");
  }
  if (recipe.servings === null) warnings.push("Could not extract serving size");
  return warnings;
}
