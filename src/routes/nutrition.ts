import { Router } from "express";
import { authToken, AuthRequest } from "../middleware/auth";
import {
  nutritionLimiter,
  nutritionDailyLimiter,
} from "../middleware/rateLimit";
import { validateNutritionRequest } from "../lib/recipeValidation";
import { extractMessageContent } from "../lib/builderGeneration";

const router = Router();

interface NutritionInfo {
  calories?: number;
  protein?: number;
  carbs?: number;
  sugar?: number;
  fat?: number;
}

router.post(
  "/calculate",
  authToken,
  nutritionLimiter,
  nutritionDailyLimiter,
  async (req: AuthRequest, res) => {
  try {
    const validated = validateNutritionRequest(
      req.body?.ingredients,
      req.body?.servings
    );
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }
    const { ingredients, servings } = validated.value;

    const prompt = `
Calculate nutritional information PER SERVING for a recipe with ${servings} servings.

Ingredients:
${ingredients.map((ing: string, i: number) => `${i + 1}. ${ing}`).join("\n")}

Respond with ONLY valid JSON. No markdown. Format must be:

{
  "calories": number,
  "protein": number,
  "carbs": number,
  "sugar": number,
  "fat": number
}

Use grams for macros. Calories is total calories.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.1,
        response_format: { type: "json_object" } // prevents non-JSON output
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("OpenAI API error:", errorData);
      return res.status(502).json({ error: "Failed to calculate nutrition" });
    }

    const data = await response.json();
    const content = extractMessageContent(data);
    if (content === null) {
      console.error("OpenAI response missing message content:", data);
      return res.status(502).json({ error: "Failed to calculate nutrition" });
    }

    let nutritionData: NutritionInfo;

    try {
      nutritionData = JSON.parse(content);
    } catch {
      console.error("Invalid OpenAI JSON:", content);
      return res.status(500).json({ error: "Invalid nutrition response format" });
    }

    res.json({ nutrition: nutritionData });
  } catch (error) {
    console.error("Calculate nutrition error:", error);
    res.status(500).json({ error: "Failed to calculate nutrition" });
  }
});

export default router;