import cors from "cors";
import express from "express";
import adminRouter from "./routes/admin";
import builderRouter from "./routes/builder";
import dishlistsRouter from "./routes/dishlists";
import healthRouter from "./routes/health";
import invitesRouter from "./routes/invites";
import notificationsRouter from "./routes/notifications";
import nutritionRouter from "./routes/nutrition";
import pushTokensRouter from "./routes/pushTokens";
import recipeRouter from "./routes/recipe";
import reportsRouter from "./routes/reports";
import searchRouter from "./routes/search";
import uploadsRouter from "./routes/uploads";
import usersRouter from "./routes/users";

export function createApp() {
  const app = express();

  app.use((req, res, next) => {
    res.on("finish", () => {
      console.log(`${req.method} ${req.path} - ${res.statusCode}`);
    });
    next();
  });

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.use("/health", healthRouter);
  app.use("/admin", adminRouter);
  app.use("/users", usersRouter);
  app.use("/dishlists", dishlistsRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/recipes", recipeRouter);
  app.use("/nutrition", nutritionRouter);
  app.use("/invites", invitesRouter);
  app.use("/search", searchRouter);
  app.use("/builder", builderRouter);
  app.use("/push-tokens", pushTokensRouter);
  app.use("/uploads", uploadsRouter);
  app.use("/reports", reportsRouter);

  return app;
}
