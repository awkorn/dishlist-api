import { Router } from "express";
import crypto from "crypto";
import { supabaseAdmin } from "../lib/supabase";
import { authToken, AuthRequest } from "../middleware/auth";
import {
  handleModerationError,
  moderateImage,
} from "../lib/moderation";
import {
  handleImageUploadError,
  normalizeUploadedImage,
} from "../lib/uploadedImages";

const router = Router();

const ALLOWED_FOLDERS = new Set(["avatars", "recipes"]);
router.post("/image", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { base64, folder } = req.body;

    if (!ALLOWED_FOLDERS.has(folder)) {
      return res.status(400).json({ error: "Invalid image folder" });
    }

    const image = await normalizeUploadedImage(base64);

    await moderateImage(image.dataUrl, {
      targetType: "IMAGE",
      userId,
    });

    const filename = `${userId}/${Date.now()}-${crypto
      .randomBytes(6)
      .toString("hex")}.${image.extension}`;

    const { error } = await supabaseAdmin.storage
      .from(folder)
      .upload(filename, image.bytes, {
        contentType: image.mimeType,
        upsert: false,
      });

    if (error) {
      console.error("Supabase moderated upload error:", error);
      return res.status(500).json({ error: "Failed to upload image" });
    }

    const { data } = supabaseAdmin.storage.from(folder).getPublicUrl(filename);

    res.status(201).json({ publicUrl: data.publicUrl });
  } catch (error) {
    if (handleImageUploadError(error, res)) return;
    if (handleModerationError(error, res)) return;

    console.error("Moderated image upload error:", error);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

export default router;
