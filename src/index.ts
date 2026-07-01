import { createApp } from "./app";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY environment variable");
}

const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`API running on http://localhost:${port}`));
