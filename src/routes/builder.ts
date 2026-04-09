import { Router } from "express";
import { authToken, AuthRequest } from "../middleware/auth";

const router = Router();

// ─── Types ──────────────────────────────────────────────────────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface GeneratedRecipe {
  title: string;
  prepTime: number | null;
  cookTime: number | null;
  servings: number | null;
  ingredients: { type: "item" | "header"; text: string }[];
  instructions: { type: "item" | "header"; text: string }[];
  tags: string[];
}

interface GenerateResponse {
  recipes: GeneratedRecipe[];
}

// ─── System Prompt ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a creative recipe assistant inside a cooking app. When the user describes what they want to cook, generate exactly 4 unique recipes that match their request.

IMPORTANT RULES:
- Always return exactly 4 recipes
- Each recipe should be complete with ingredients and step-by-step instructions
- Vary the recipes: different cuisines, difficulty levels, or approaches
- If the user refines a previous request (e.g., "make it spicier", "without dairy"), adjust ALL 4 recipes accordingly based on the conversation history
- Include realistic prep/cook times and servings
- Use subsection headers (type: "header") for ingredients/instructions when a recipe has distinct parts (e.g., "For the Sauce", "For the Dough")

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
      ],
      "tags": ["italian", "dinner", "comfort-food"]
    }
  ]
}`;

// ─── POST /builder/generate ─────────────────────────────────────────
router.post("/generate", authToken, async (req: AuthRequest, res) => {
  try {
    const { prompt, history, preferences } = req.body;

    // Validate input
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "A prompt is required" });
    }

    // Build conversation messages for OpenAI
    const messages: { role: string; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // Add preferences context if provided
    if (preferences && Array.isArray(preferences) && preferences.length > 0) {
      messages.push({
        role: "system",
        content: `The user has the following dietary preferences/restrictions that should be respected in ALL recipes: ${preferences.join(", ")}`,
      });
    }

    // Add conversation history for multi-turn
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        if (msg.role === "user" || msg.role === "assistant") {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
        }
      }
    }

    // Add the current prompt
    messages.push({ role: "user", content: prompt.trim() });

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
    const content = data.choices[0].message.content;

    let parsed: GenerateResponse;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("Invalid OpenAI JSON response:", content);
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Validate response structure
    if (!parsed.recipes || !Array.isArray(parsed.recipes)) {
      return res.status(500).json({ error: "Invalid recipe response format" });
    }

    // Normalize recipes
    const recipes: GeneratedRecipe[] = parsed.recipes.slice(0, 4).map((r) => ({
      title: r.title || "Untitled Recipe",
      prepTime: typeof r.prepTime === "number" ? r.prepTime : null,
      cookTime: typeof r.cookTime === "number" ? r.cookTime : null,
      servings: typeof r.servings === "number" ? r.servings : null,
      ingredients: Array.isArray(r.ingredients)
        ? r.ingredients.map((i) => ({
            type: i.type === "header" ? "header" as const : "item" as const,
            text: i.text || "",
          }))
        : [],
      instructions: Array.isArray(r.instructions)
        ? r.instructions.map((i) => ({
            type: i.type === "header" ? "header" as const : "item" as const,
            text: i.text || "",
          }))
        : [],
      tags: Array.isArray(r.tags) ? r.tags : [],
    }));

    res.json({
      recipes,
      // Return the assistant's raw content for conversation history
      assistantContent: content,
    });
  } catch (error) {
    console.error("Recipe generation error:", error);
    res.status(500).json({ error: "Failed to generate recipes" });
  }
});

export default router;
