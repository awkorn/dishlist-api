import express from "express";
import cors from "cors";
import healthRouter from "./routes/health";
import usersRouter from "./routes/users";
import "./lib/firebase";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/health", healthRouter);
app.use("/users", usersRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
