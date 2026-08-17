import { extractMessageContent } from "../builderGeneration";
import {
  normalizeImportedRecipe,
  type NormalizedImportedRecipe,
} from "../recipeValidation";
import { RECIPE_JSON_STRUCTURE } from "./captionExtraction";
import { safeRemoteFetch, withTimeoutSignal } from "./safeRemoteFetch";
import { SocialImportError } from "./types";

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function extractRecipeFromPostImages(
  urls: string[],
  signal?: AbortSignal
): Promise<NormalizedImportedRecipe | null> {
  const unique = [...new Set(urls)].slice(0, MAX_IMAGES);
  if (unique.length === 0) return null;

  const images: { dataUrl: string }[] = [];
  for (const url of unique) {
    try {
      const response = await safeRemoteFetch(url, {
        signal: withTimeoutSignal(signal, 15_000),
        maxBytes: MAX_IMAGE_BYTES,
        allowedMimePrefixes: ["image/"],
      });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
      const mime = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
      images.push({ dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("Social carousel image skipped:", error);
    }
  }
  if (images.length === 0) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract a recipe only from the provided social post images, including text overlays. Do not invent missing ingredients or steps. If no usable recipe exists return {"found":false}; otherwise return {"found":true,"recipe":<recipe>} using:\n${RECIPE_JSON_STRUCTURE}`,
            },
            ...images.map(({ dataUrl }) => ({
              type: "image_url",
              image_url: { url: dataUrl, detail: "high" },
            })),
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 3000,
      response_format: { type: "json_object" },
    }),
    signal: withTimeoutSignal(signal, 90_000),
  });
  if (!response.ok) {
    throw new SocialImportError("INTERNAL", `Image extraction returned ${response.status}`);
  }
  const content = extractMessageContent(await response.json());
  if (!content) throw new SocialImportError("INTERNAL", "Image extraction was empty");
  let parsed: { found?: unknown; recipe?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new SocialImportError("INTERNAL", "Image extraction returned invalid JSON");
  }
  if (parsed.found !== true || !parsed.recipe) return null;
  const recipe = normalizeImportedRecipe(parsed.recipe);
  return recipe.title && recipe.ingredients.length > 0 ? recipe : null;
}
