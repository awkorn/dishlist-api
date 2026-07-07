import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  NORMALIZED_IMAGE_EXTENSION,
  NORMALIZED_IMAGE_MIME_TYPE,
  normalizeUploadedImage,
} from "../uploadedImages";

async function makePngBase64() {
  const bytes = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: "#f04f3a",
    },
  })
    .png()
    .toBuffer();

  return bytes.toString("base64");
}

describe("normalizeUploadedImage", () => {
  it("converts image bytes to a moderated/uploadable JPEG", async () => {
    const image = await normalizeUploadedImage(await makePngBase64());

    expect(image.mimeType).toBe(NORMALIZED_IMAGE_MIME_TYPE);
    expect(image.extension).toBe(NORMALIZED_IMAGE_EXTENSION);
    expect(image.dataUrl).toMatch(/^data:image\/jpeg;base64,/);

    const metadata = await sharp(image.bytes).metadata();
    expect(metadata.format).toBe("jpeg");
  });

  it("accepts image data URLs and normalizes their bytes", async () => {
    const base64 = await makePngBase64();
    const image = await normalizeUploadedImage(`data:image/png;base64,${base64}`);

    expect(image.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("rejects invalid image data before moderation", async () => {
    await expect(normalizeUploadedImage("bm90LWltYWdlLWJ5dGVz")).rejects.toThrow(
      "Unsupported or invalid image data"
    );
  });
});
