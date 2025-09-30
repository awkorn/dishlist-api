import { Router } from "express";
import { authToken, AuthRequest } from "../middleware/auth";

const router = Router();

interface NutritionInfo {
  calories?: number;
  protein?: number;
  carbs?: number;
  sugar?: number;
  fat?: number;
}

router.post("/calculate", authToken, async (req: AuthRequest, res) => {
  try {
    const { ingredients, servings } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "Ingredients array is required" });
    }

    if (!servings || servings < 1) {
      return res.status(400).json({ error: "Valid servings number is required" });
    }

    const prompt = `Calculate the nutritional information per serving for a recipe with ${servings} servings using these ingredients:
${ingredients.map((ing: string, i: number) => `${i + 1}. ${ing}`).join('\n')}

Please respond with ONLY a JSON object in this exact format:
{
  "calories": number,
  "protein": number,
  "carbs": number,
  "sugar": number,
  "fat": number
}

All values should be numbers representing grams except calories. Be as accurate as possible.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to calculate nutrition with OpenAI');
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();

    let nutritionData: NutritionInfo;
    try {
      nutritionData = JSON.parse(content);
    } catch (error) {
      console.error('Failed to parse nutrition response:', content);
      return res.status(500).json({ error: 'Invalid nutrition response format' });
    }

    res.json({ nutrition: nutritionData });
  } catch (error) {
    console.error("Calculate nutrition error:", error);
    res.status(500).json({ error: "Failed to calculate nutrition" });
  }
});

export default router;