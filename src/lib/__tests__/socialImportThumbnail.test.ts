import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({
  supabaseAdmin: {
    storage: {
      from: vi.fn(),
    },
  },
}));
vi.mock("../moderation", () => ({ moderateImage: vi.fn() }));
vi.mock("../uploadedImages", () => ({ normalizeUploadedImage: vi.fn() }));
vi.mock("../socialImport/safeRemoteFetch", () => ({
  safeRemoteFetch: vi.fn(),
  withTimeoutSignal: vi.fn(() => new AbortController().signal),
}));

import { moderateImage } from "../moderation";
import { supabaseAdmin } from "../supabase";
import { ingestThumbnail } from "../socialImport/thumbnail";
import { safeRemoteFetch } from "../socialImport/safeRemoteFetch";
import { normalizeUploadedImage } from "../uploadedImages";

const previousIngestionFlag = process.env.SOCIAL_THUMBNAIL_INGESTION_ENABLED;

describe("social import thumbnail ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SOCIAL_THUMBNAIL_INGESTION_ENABLED;

    (safeRemoteFetch as any).mockResolvedValue({
      ok: true,
      headers: new Headers({
        "content-length": "3",
        "content-type": "image/jpeg",
      }),
      arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
    });
    (normalizeUploadedImage as any).mockResolvedValue({
      bytes: Buffer.from([4, 5, 6]),
      dataUrl: "data:image/jpeg;base64,BAUG",
      mimeType: "image/jpeg",
      extension: "jpg",
    });
    (moderateImage as any).mockResolvedValue(undefined);
    (supabaseAdmin.storage.from as any).mockReturnValue({
      upload: vi.fn().mockResolvedValue({ error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: "https://storage.example.com/social-thumbnail.jpg" },
      }),
    });
  });

  afterEach(() => {
    if (previousIngestionFlag === undefined) {
      delete process.env.SOCIAL_THUMBNAIL_INGESTION_ENABLED;
    } else {
      process.env.SOCIAL_THUMBNAIL_INGESTION_ENABLED = previousIngestionFlag;
    }
  });

  it("ingests a thumbnail when no feature flag is configured", async () => {
    const result = await ingestThumbnail(
      "user_1",
      "https://cdn.example.com/thumbnail.jpg"
    );

    expect(result).toBe("https://storage.example.com/social-thumbnail.jpg");
    expect(safeRemoteFetch).toHaveBeenCalledWith(
      "https://cdn.example.com/thumbnail.jpg",
      expect.objectContaining({
        maxBytes: 8 * 1024 * 1024,
        allowedMimePrefixes: ["image/"],
      })
    );
    expect(normalizeUploadedImage).toHaveBeenCalled();
    expect(moderateImage).toHaveBeenCalledWith(
      "data:image/jpeg;base64,BAUG",
      { targetType: "IMAGE", userId: "user_1" }
    );
  });
});
