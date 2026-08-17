import {
  getImportWarnings,
  type NormalizedImportedRecipe,
} from "../recipeValidation";

export interface ImportQuality {
  warnings: string[];
  confidence: number;
  needsReview: boolean;
}

export function assessImportQuality(
  recipe: NormalizedImportedRecipe,
  options: { multipleRecipesDetected?: boolean } = {}
): ImportQuality {
  const warnings = getImportWarnings(recipe);
  if (options.multipleRecipesDetected) {
    warnings.unshift("This post may contain multiple recipes; verify the selected one");
  }

  let confidence = 1;
  if (!recipe.title) confidence -= 0.35;
  if (recipe.ingredients.length === 0) confidence -= 0.4;
  if (recipe.instructions.length === 0) confidence -= 0.25;
  if (recipe.prepTime === null && recipe.cookTime === null) confidence -= 0.05;
  if (recipe.servings === null) confidence -= 0.05;
  if (options.multipleRecipesDetected) confidence -= 0.15;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  return {
    warnings,
    confidence,
    needsReview:
      confidence < 0.8 ||
      recipe.instructions.length === 0 ||
      recipe.ingredients.length === 0 ||
      Boolean(options.multipleRecipesDetected),
  };
}
