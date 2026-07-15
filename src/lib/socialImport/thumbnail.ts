// Best-effort thumbnail ingestion: fetch the post's cover image, run it
// through the same normalize → moderate → Supabase Storage pipeline as user
// uploads (routes/uploads.ts), and return the public URL. Every failure path
// returns null — a missing thumbnail must never fail the import.

import crypto from "crypto";
import { supabaseAdmin } from "../supabase";
import { moderateImage } from "../moderation";
import { normalizeUploadedImage } from "../uploadedImages";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

export async function ingestThumbnail(
  userId: string,
  thumbnailUrl: string | null
): Promise<string | null> {
  if (!thumbnailUrl) return null;

  try {
    const response = await fetch(thumbnailUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`Thumbnail fetch returned ${response.status}`);
      return null;
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_THUMBNAIL_BYTES) {
      console.warn("Thumbnail exceeds size cap, skipping");
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) {
      return null;
    }

    // normalizeUploadedImage accepts base64; it re-encodes to a bounded JPEG.
    const image = await normalizeUploadedImage(bytes.toString("base64"));

    await moderateImage(image.dataUrl, { targetType: "IMAGE", userId });

    const filename = `${userId}/social/${Date.now()}-${crypto
      .randomBytes(6)
      .toString("hex")}.${image.extension}`;

    const { error } = await supabaseAdmin.storage
      .from("recipes")
      .upload(filename, image.bytes, {
        contentType: image.mimeType,
        upsert: false,
      });
    if (error) {
      console.warn("Thumbnail upload failed:", error);
      return null;
    }

    const { data } = supabaseAdmin.storage
      .from("recipes")
      .getPublicUrl(filename);
    return data.publicUrl;
  } catch (error) {
    // Includes moderation rejections: a blocked thumbnail drops the image but
    // the extracted recipe text (moderated separately) still saves.
    console.warn("Thumbnail ingestion failed:", error);
    return null;
  }
}
