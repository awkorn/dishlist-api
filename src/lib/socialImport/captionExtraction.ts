// Caption-first recipe extraction: one GPT-4o call that both judges whether
// the caption contains a usable recipe and extracts it when it does. Mirrors
// the import-from-images pattern (routes/recipe.ts): raw fetch to
// chat/completions, JSON mode, temperature 0.1, normalized via
// normalizeImportedRecipe. Returns { sufficient: false } rather than throwing
// so the orchestrator can fall through to video extraction.

import { extractMessageContent } from "../builderGeneration";
import {
  normalizeImportedRecipe,
  type NormalizedImportedRecipe,
} from "../recipeValidation";
import { SocialImportError } from "./types";

// Captions shorter than this can't hold an ingredient list — skip the model
// call entirely and go straight to the video fallback.
export const MIN_CAPTION_LENGTH = 80;

// Captions can be long, but past this size they're almost certainly comment
// spam / hashtag walls; truncate to bound token cost.
const MAX_CAPTION_LENGTH = 8000;

export type CaptionExtractionResult =
  | { sufficient: true; recipe: NormalizedImportedRecipe }
  | { sufficient: false };

// Shared with the Gemini fallback so both extractors emit the same shape.
export const RECIPE_JSON_STRUCTURE = `{
  "title": "Recipe Name",
  "prepTime": number or null (in minutes),
  "cookTime": number or null (in minutes),
  "servings": number or null,
  "ingredients": [
    { "type": "item", "text": "2 cups flour" },
    { "type": "header", "text": "For the Sauce" },
    { "type": "item", "text": "1 can tomatoes" }
  ],
  "instructions": [
    { "type": "item", "text": "Preheat oven to 350°F" },
    { "type": "header", "text": "Making the Sauce" },
    { "type": "item", "text": "Heat oil in a pan" }
  ]
}

Rules:
- Each ingredient should be a complete item (e.g., "2 cups all-purpose flour")
- Each instruction should be a complete step
- Subsection headers should be concise (e.g., "For the Sauce", "Dough", "Assembly")
- If no clear subsections exist, just use type "item" for everything
- If information is not available, use null for that field
- Do not include empty strings in arrays`;

export async function extractRecipeFromCaption(
  caption: string | null
): Promise<CaptionExtractionResult> {
  if (!caption || caption.trim().length < MIN_CAPTION_LENGTH) {
    return { sufficient: false };
  }

  const trimmedCaption = caption.trim().slice(0, MAX_CAPTION_LENGTH);

  const prompt = `You are a recipe extraction assistant. You are given the caption of a social media cooking post.

First decide whether the caption itself contains a usable recipe: it must name an identifiable dish AND include a substantially complete ingredient list (instructions may be brief or summarized). Captions that are only a teaser ("recipe in comments", "link in bio", "follow for the recipe"), only hashtags, or missing ingredient amounts/lists are NOT usable.

- If the caption contains a usable recipe, respond with: {"sufficient": true, "recipe": <recipe object>}
- If it does not, respond with: {"sufficient": false, "reason": "brief reason"}

Do NOT invent ingredients, amounts, or steps that are not present in the caption.

The recipe object must have this exact structure:
${RECIPE_JSON_STRUCTURE}
- Return ONLY the JSON object, no additional text

Caption:
"""
${trimmedCaption}
"""`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error("OpenAI caption extraction error:", errorData);
    throw new SocialImportError(
      "INTERNAL",
      `OpenAI returned ${response.status}`
    );
  }

  const data = await response.json();
  const content = extractMessageContent(data);
  if (content === null) {
    console.error("OpenAI caption response missing content:", data);
    throw new SocialImportError("INTERNAL", "OpenAI response missing content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.error("Invalid OpenAI caption JSON:", content);
    throw new SocialImportError("INTERNAL", "OpenAI returned invalid JSON");
  }

  const result = parsed as { sufficient?: unknown; recipe?: unknown };
  if (result?.sufficient !== true || !result.recipe) {
    return { sufficient: false };
  }

  const recipe = normalizeImportedRecipe(result.recipe);
  // A "sufficient" answer without the essentials is a model mistake — treat it
  // as insufficient so the video fallback still gets a chance.
  if (!recipe.title || recipe.ingredients.length === 0) {
    return { sufficient: false };
  }

  return {
    sufficient: true,
    recipe: { ...recipe, description: null },
  };
}
