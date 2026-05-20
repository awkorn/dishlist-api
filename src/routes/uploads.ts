import { Router } from "express";
import crypto from "crypto";
import { supabaseAdmin } from "../lib/supabase";
import { authToken, AuthRequest } from "../middleware/auth";
import {
  handleModerationError,
  moderateImage,
} from "../lib/moderation";

const router = Router();

const ALLOWED_FOLDERS = new Set(["avatars", "recipes"]);
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

router.post("/image", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { base64, mimeType = "image/jpeg", folder } = req.body;

    if (!ALLOWED_FOLDERS.has(folder)) {
      return res.status(400).json({ error: "Invalid image folder" });
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({ error: "Unsupported image type" });
    }

    if (typeof base64 !== "string" || !base64.trim()) {
      return res.status(400).json({ error: "Image data is required" });
    }

    const normalizedBase64 = base64.replace(/^data:[^;]+;base64,/, "");
    const dataUrl = `data:${mimeType};base64,${normalizedBase64}`;

    await moderateImage(dataUrl, {
      targetType: "IMAGE",
      userId,
    });

    const bytes = Buffer.from(normalizedBase64, "base64");
    const extension = extensionForMimeType(mimeType);
    const filename = `${userId}/${Date.now()}-${crypto
      .randomBytes(6)
      .toString("hex")}.${extension}`;

    const { error } = await supabaseAdmin.storage
      .from(folder)
      .upload(filename, bytes, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      console.error("Supabase moderated upload error:", error);
      return res.status(500).json({ error: "Failed to upload image" });
    }

    const { data } = supabaseAdmin.storage.from(folder).getPublicUrl(filename);

    res.status(201).json({ publicUrl: data.publicUrl });
  } catch (error) {
    if (handleModerationError(error, res)) return;

    console.error("Moderated image upload error:", error);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

export default router;
