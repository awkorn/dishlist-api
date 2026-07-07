import sharp from "sharp";
import type { Response } from "express";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const JPEG_QUALITY = 85;

export const NORMALIZED_IMAGE_MIME_TYPE = "image/jpeg";
export const NORMALIZED_IMAGE_EXTENSION = "jpg";

export class ImageUploadError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ImageUploadError";
    this.statusCode = statusCode;
  }
}

interface NormalizedImage {
  bytes: Buffer;
  dataUrl: string;
  mimeType: typeof NORMALIZED_IMAGE_MIME_TYPE;
  extension: typeof NORMALIZED_IMAGE_EXTENSION;
}

function extractBase64(value: string) {
  const trimmed = value.trim();
  const dataUrlMatch = trimmed.match(/^data:image\/[a-z0-9.+-]+;base64,(.*)$/i);
  const base64 = (dataUrlMatch ? dataUrlMatch[1] : trimmed).replace(/\s/g, "");

  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ImageUploadError("Invalid image data");
  }

  return base64;
}

function decodeBase64Image(base64: string) {
  const bytes = Buffer.from(base64, "base64");

  if (bytes.length === 0) {
    throw new ImageUploadError("Image data is required");
  }

  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ImageUploadError("Image is too large");
  }

  return bytes;
}

export async function normalizeUploadedImage(value: unknown): Promise<NormalizedImage> {
  if (typeof value !== "string" || !value.trim()) {
    throw new ImageUploadError("Image data is required");
  }

  const originalBytes = decodeBase64Image(extractBase64(value));

  try {
    const bytes = await sharp(originalBytes, {
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: JPEG_QUALITY,
        mozjpeg: true,
      })
      .toBuffer();

    const base64 = bytes.toString("base64");

    return {
      bytes,
      dataUrl: `data:${NORMALIZED_IMAGE_MIME_TYPE};base64,${base64}`,
      mimeType: NORMALIZED_IMAGE_MIME_TYPE,
      extension: NORMALIZED_IMAGE_EXTENSION,
    };
  } catch (error) {
    console.error("Image normalization failed:", error);
    throw new ImageUploadError("Unsupported or invalid image data");
  }
}

export function handleImageUploadError(error: unknown, res: Response) {
  if (error instanceof ImageUploadError) {
    res.status(error.statusCode).json({ error: error.message });
    return true;
  }

  return false;
}
