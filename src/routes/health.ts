import { Router } from "express";
import prisma from "../lib/prisma";

const router = Router();

router.get("/", async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected" });
  } catch (e) {
    res.status(500).json({ status: "error", db: "disconnected" });
  }
});

export default router;
