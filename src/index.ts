import express from "express";
import cors from "cors";
import healthRouter from "./routes/health";
import usersRouter from "./routes/users";
import dishlistsRouter from "./routes/dishlists";
import recipeRouter from "./routes/recipe";
import nutritionRouter from "./routes/nutrition";
import "./lib/firebase";

if (!process.env.OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY environment variable');
}

const app = express();

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - ${res.statusCode}`);
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use("/health", healthRouter);
app.use("/users", usersRouter);
app.use("/dishlists", dishlistsRouter);
app.use("/recipes", recipeRouter);
app.use("/nutrition", nutritionRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
