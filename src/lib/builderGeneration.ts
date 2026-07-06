// Pure helpers for the recipe builder endpoint: input validation, history
// trimming, and response normalization. Kept dependency-free and side-effect
// free so they can be unit tested directly (see __tests__/builderGeneration.test.ts).

export const MAX_PROMPT_LENGTH = 2000;
export const MAX_HISTORY_TURNS = 6; // last N user/assistant messages sent to OpenAI
export const MAX_PREFERENCES = 20;
export const MAX_PREFERENCE_LENGTH = 100;
export const MAX_RECIPES = 4;

export class BuilderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderValidationError";
  }
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ValidatedBuilderInput {
  prompt: string;
  history: ConversationTurn[];
  preferences: string[];
}

export interface GeneratedRecipe {
  title: string;
  prepTime: number | null;
  cookTime: number | null;
  servings: number | null;
  ingredients: { type: "item" | "header"; text: string }[];
  instructions: { type: "item" | "header"; text: string }[];
}

/**
 * Validate and normalize the raw request body. Throws BuilderValidationError
 * (→ 400) on bad input. Caps prompt length, trims conversation history to the
 * most recent MAX_HISTORY_TURNS, and bounds the preferences list so a single
 * request cannot balloon token cost.
 */
export function validateBuilderInput(body: unknown): ValidatedBuilderInput {
  const { prompt, history, preferences } = (body ?? {}) as {
    prompt?: unknown;
    history?: unknown;
    preferences?: unknown;
  };

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new BuilderValidationError("A prompt is required");
  }
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
    throw new BuilderValidationError(
      `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer`
    );
  }

  const normalizedHistory: ConversationTurn[] = Array.isArray(history)
    ? history
        .filter(
          (m): m is ConversationTurn =>
            !!m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-MAX_HISTORY_TURNS)
    : [];

  const normalizedPreferences: string[] = Array.isArray(preferences)
    ? preferences
        .filter((p): p is string => typeof p === "string" && !!p.trim())
        .map((p) => p.trim().slice(0, MAX_PREFERENCE_LENGTH))
        .slice(0, MAX_PREFERENCES)
    : [];

  return {
    prompt: trimmedPrompt,
    history: normalizedHistory,
    preferences: normalizedPreferences,
  };
}

/**
 * Normalize the model's parsed JSON into at most MAX_RECIPES well-formed
 * recipes. Returns null when the payload isn't the expected shape so the caller
 * can respond with a clear error instead of throwing.
 */
export function normalizeRecipes(parsed: unknown): GeneratedRecipe[] | null {
  const recipes = (parsed as { recipes?: unknown })?.recipes;
  if (!Array.isArray(recipes)) return null;

  return recipes.slice(0, MAX_RECIPES).map((r) => {
    const recipe = (r ?? {}) as Partial<GeneratedRecipe>;
    return {
      title: typeof recipe.title === "string" ? recipe.title : "Untitled Recipe",
      prepTime: typeof recipe.prepTime === "number" ? recipe.prepTime : null,
      cookTime: typeof recipe.cookTime === "number" ? recipe.cookTime : null,
      servings: typeof recipe.servings === "number" ? recipe.servings : null,
      ingredients: normalizeLines(recipe.ingredients),
      instructions: normalizeLines(recipe.instructions),
    };
  });
}

function normalizeLines(
  lines: unknown
): { type: "item" | "header"; text: string }[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const l = (line ?? {}) as { type?: unknown; text?: unknown };
    return {
      type: l.type === "header" ? ("header" as const) : ("item" as const),
      text: typeof l.text === "string" ? l.text : "",
    };
  });
}

/**
 * Safely extract the assistant message content from an OpenAI chat completion.
 * Returns null when the response shape is unexpected (e.g. empty choices from a
 * moderation refusal) so the caller can return a 502 rather than crashing.
 */
export function extractMessageContent(data: unknown): string | null {
  const content = (data as any)?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}
