import { Router } from "express";
import { authToken, AuthRequest } from "../middleware/auth";
import {
  aiGenerateLimiter,
  aiGenerateDailyLimiter,
} from "../middleware/rateLimit";
import {
  validateBuilderInput,
  normalizeRecipes,
  extractMessageContent,
  BuilderValidationError,
} from "../lib/builderGeneration";

const router = Router();

// ─── System Prompt ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a creative recipe assistant inside a cooking app. When the user describes what they want to cook, generate exactly 4 unique recipes that match their request.

IMPORTANT RULES:
- Always return exactly 4 recipes
- Each recipe should be complete with ingredients and step-by-step instructions
- Vary the recipes: different cuisines, difficulty levels, or approaches
- If the user refines a previous request (e.g., "make it spicier", "without dairy"), adjust ALL 4 recipes accordingly based on the conversation history
- Include realistic prep/cook times and servings
- Use subsection headers (type: "header") for ingredients/instructions when a recipe has distinct parts (e.g., "For the Sauce", "For the Dough")
- Do not include tags

RESPONSE FORMAT - respond with ONLY valid JSON, no markdown:
{
  "recipes": [
    {
      "title": "Recipe Name",
      "prepTime": 15,
      "cookTime": 30,
      "servings": 4,
      "ingredients": [
        { "type": "item", "text": "2 cups all-purpose flour" },
        { "type": "header", "text": "For the Sauce" },
        { "type": "item", "text": "1 can crushed tomatoes" }
      ],
      "instructions": [
        { "type": "item", "text": "Preheat oven to 375°F" },
        { "type": "header", "text": "Making the Sauce" },
        { "type": "item", "text": "Heat oil in a saucepan over medium heat" }
      ]
    }
  ]
}`;

// ─── POST /builder/generate ─────────────────────────────────────────
router.post(
  "/generate",
  authToken,
  aiGenerateLimiter,
  aiGenerateDailyLimiter,
  async (req: AuthRequest, res) => {
  try {
    // Validate + normalize input (caps prompt length, history turns, prefs)
    let prompt: string;
    let history: { role: "user" | "assistant"; content: string }[];
    let preferences: string[];
    try {
      ({ prompt, history, preferences } = validateBuilderInput(req.body));
    } catch (err) {
      if (err instanceof BuilderValidationError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    // Build conversation messages for OpenAI
    const messages: { role: string; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // Add preferences context if provided
    if (preferences.length > 0) {
      messages.push({
        role: "system",
        content: `The user has the following dietary preferences/restrictions that should be respected in ALL recipes: ${preferences.join(", ")}`,
      });
    }

    // Add conversation history for multi-turn
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // Add the current prompt
    messages.push({ role: "user", content: prompt });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        max_tokens: 4000,
        temperature: 0.8, // Slightly creative for recipe variety
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("OpenAI API error:", errorData);
      return res.status(502).json({ error: "Failed to generate recipes" });
    }

    const data = await response.json();
    const content = extractMessageContent(data);
    if (content === null) {
      console.error("OpenAI response missing message content:", data);
      return res.status(502).json({ error: "Failed to generate recipes" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("Invalid OpenAI JSON response:", content);
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    const recipes = normalizeRecipes(parsed);
    if (recipes === null) {
      return res.status(500).json({ error: "Invalid recipe response format" });
    }

    res.json({
      recipes,
      // Return normalized content for conversation history so tags are not
      // carried forward if the model includes them anyway.
      assistantContent: JSON.stringify({ recipes }),
    });
  } catch (error) {
    console.error("Recipe generation error:", error);
    res.status(500).json({ error: "Failed to generate recipes" });
  }
});

export default router;
