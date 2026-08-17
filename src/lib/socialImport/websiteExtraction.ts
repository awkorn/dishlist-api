import {
  normalizeImportedRecipe,
  type NormalizedImportedRecipe,
} from "../recipeValidation";
import { safeRemoteFetch, withTimeoutSignal } from "./safeRemoteFetch";

const MAX_HTML_BYTES = 2 * 1024 * 1024;

function findRecipeNode(value: unknown): Record<string, any> | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecipeNode(entry);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, any>;
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  if (types.some((type) => String(type).toLowerCase() === "recipe")) return node;
  return findRecipeNode(node["@graph"]);
}

function instructionText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    const node = entry as Record<string, unknown>;
    if (Array.isArray(node.itemListElement)) return instructionText(node.itemListElement);
    return typeof node.text === "string" ? [node.text] : [];
  });
}

function isoDurationMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  return minutes > 0 ? minutes : null;
}

export async function extractRecipeFromWebsite(
  urls: string[],
  signal?: AbortSignal
): Promise<NormalizedImportedRecipe | null> {
  for (const url of urls.slice(0, 3)) {
    try {
      const response = await safeRemoteFetch(url, {
        signal: withTimeoutSignal(signal, 12_000),
        maxBytes: MAX_HTML_BYTES,
        allowedMimePrefixes: ["text/html", "application/xhtml+xml"],
        headers: { "User-Agent": "DishListRecipeImporter/1.0" },
      });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_HTML_BYTES) continue;
      const html = bytes.toString("utf8");
      const scripts = html.matchAll(
        /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      );
      for (const match of scripts) {
        try {
          const node = findRecipeNode(JSON.parse(match[1]));
          if (!node) continue;
          const recipe = normalizeImportedRecipe({
            title: node.name,
            description: node.description,
            prepTime: isoDurationMinutes(node.prepTime),
            cookTime: isoDurationMinutes(node.cookTime),
            servings:
              typeof node.recipeYield === "number"
                ? node.recipeYield
                : Number(String(node.recipeYield ?? "").match(/\d+/)?.[0]) || null,
            ingredients: Array.isArray(node.recipeIngredient)
              ? node.recipeIngredient.map((text: unknown) => ({ type: "item", text }))
              : [],
            instructions: instructionText(node.recipeInstructions).map((text) => ({
              type: "item",
              text,
            })),
          });
          if (recipe.title && recipe.ingredients.length > 0) return recipe;
        } catch {
          // A page can contain multiple JSON-LD blocks; one malformed block
          // should not prevent trying the rest.
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("Recipe JSON-LD fallback skipped:", error);
    }
  }
  return null;
}
