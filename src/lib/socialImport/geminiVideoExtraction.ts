// Full-video recipe extraction via Gemini Flash — the fallback when the
// caption doesn't contain a usable recipe. Many social recipes exist only as
// spoken narration or on-screen text, so this pass reads audio + on-screen
// text + visuals in one shot.
//
// App Review posture: the video is downloaded to a temp file, uploaded to the
// Gemini Files API for extraction, and BOTH copies are deleted in `finally`.
// It is never persisted, served, or playable by users.
//
// Uses raw fetch against the Gemini REST API (no SDK), matching how the
// OpenAI integrations in this codebase are written.

import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import {
  normalizeImportedRecipe,
  type NormalizedImportedRecipe,
} from "../recipeValidation";
import { RECIPE_JSON_STRUCTURE } from "./captionExtraction";
import { SocialImportError, type SocialPost } from "./types";

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export const MAX_VIDEO_DURATION_SEC = 600; // 10 minutes
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const FILE_ACTIVE_POLL_INTERVAL_MS = 2_000;
const FILE_ACTIVE_TIMEOUT_MS = 2 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 120_000;

export async function extractRecipeFromVideo(
  post: SocialPost
): Promise<NormalizedImportedRecipe> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not configured");
    throw new SocialImportError("INTERNAL");
  }

  if (!post.videoUrl) {
    throw new SocialImportError("NO_RECIPE_FOUND");
  }
  if (post.durationSec !== null && post.durationSec > MAX_VIDEO_DURATION_SEC) {
    throw new SocialImportError("VIDEO_TOO_LONG");
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `dishlist-import-${crypto.randomBytes(8).toString("hex")}.mp4`
  );
  let geminiFileName: string | null = null;

  try {
    const videoBytes = await downloadVideo(post.videoUrl, tmpPath);
    const file = await uploadToGemini(apiKey, tmpPath, videoBytes);
    geminiFileName = file.name;
    await waitUntilActive(apiKey, file.name);
    return await generateRecipe(apiKey, file.uri, post.caption);
  } finally {
    // The transient video copies must never outlive the extraction.
    await fsp.unlink(tmpPath).catch(() => {});
    if (geminiFileName) {
      await deleteGeminiFile(apiKey, geminiFileName).catch((error) =>
        console.warn("Failed to delete Gemini file:", error)
      );
    }
  }
}

async function downloadVideo(videoUrl: string, tmpPath: string) {
  let response: Response;
  try {
    response = await fetch(videoUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new SocialImportError("TIMEOUT", "Video download timed out");
    }
    throw new SocialImportError(
      "SCRAPE_FAILED",
      `Video download failed: ${(error as Error)?.message}`
    );
  }

  if (!response.ok || !response.body) {
    throw new SocialImportError(
      "SCRAPE_FAILED",
      `Video download returned ${response.status}`
    );
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES) {
    throw new SocialImportError("VIDEO_TOO_LONG", "Video exceeds size cap");
  }

  // Enforce the byte cap on the actual stream too — content-length can lie.
  let received = 0;
  const capGuard = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_VIDEO_BYTES) {
        callback(new SocialImportError("VIDEO_TOO_LONG", "Video exceeds size cap"));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(response.body, capGuard, fs.createWriteStream(tmpPath));
  } catch (error) {
    if (error instanceof SocialImportError) throw error;
    throw new SocialImportError(
      "SCRAPE_FAILED",
      `Video download stream failed: ${(error as Error)?.message}`
    );
  }

  return received;
}

async function uploadToGemini(
  apiKey: string,
  tmpPath: string,
  videoBytes: number
): Promise<{ name: string; uri: string }> {
  // Resumable upload: start → single upload+finalize chunk.
  const startResponse = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(videoBytes),
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "social-import" } }),
  });

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!startResponse.ok || !uploadUrl) {
    console.error("Gemini upload start failed:", startResponse.status);
    throw new SocialImportError("INTERNAL", "Gemini upload initiation failed");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "Content-Length": String(videoBytes),
    },
    body: fs.createReadStream(tmpPath) as unknown as BodyInit,
    // @ts-expect-error Node fetch requires duplex for stream bodies.
    duplex: "half",
  });

  if (!uploadResponse.ok) {
    console.error("Gemini upload failed:", uploadResponse.status);
    throw new SocialImportError("INTERNAL", "Gemini upload failed");
  }

  const uploaded = (await uploadResponse.json()) as {
    file?: { name?: string; uri?: string };
  };
  if (!uploaded?.file?.name || !uploaded?.file?.uri) {
    throw new SocialImportError("INTERNAL", "Gemini upload returned no file");
  }
  return { name: uploaded.file.name, uri: uploaded.file.uri };
}

async function waitUntilActive(apiKey: string, fileName: string) {
  const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`${GEMINI_BASE}/v1beta/${fileName}`, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (response.ok) {
      const file = (await response.json()) as { state?: string };
      if (file.state === "ACTIVE") return;
      if (file.state === "FAILED") {
        throw new SocialImportError("INTERNAL", "Gemini file processing failed");
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, FILE_ACTIVE_POLL_INTERVAL_MS)
    );
  }
  throw new SocialImportError("TIMEOUT", "Gemini file never became ACTIVE");
}

async function deleteGeminiFile(apiKey: string, fileName: string) {
  await fetch(`${GEMINI_BASE}/v1beta/${fileName}`, {
    method: "DELETE",
    headers: { "x-goog-api-key": apiKey },
  });
}

async function generateRecipe(
  apiKey: string,
  fileUri: string,
  caption: string | null
): Promise<NormalizedImportedRecipe> {
  const prompt = `You are a recipe extraction assistant. Watch this cooking video and extract the complete recipe.

Use ALL available signals:
- Spoken narration (what the creator says)
- On-screen text overlays (many creators show ingredients/amounts as text only)
- What is visually happening (techniques, order of steps)
${caption ? `\nThe post caption is provided as extra context (it did not contain a full recipe on its own):\n"""\n${caption.slice(0, 2000)}\n"""\n` : ""}
If the video does not actually demonstrate or describe a recipe, respond with: {"found": false}

Otherwise respond with: {"found": true, "recipe": <recipe object>}

Do NOT invent ingredients or amounts that are neither shown, spoken, nor written on screen. If an amount is not given, state the ingredient without an amount.

The recipe object must have this exact structure:
${RECIPE_JSON_STRUCTURE}
- Return ONLY the JSON object, no additional text`;

  let response: Response;
  try {
    response = await fetch(
      `${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { file_data: { file_uri: fileUri, mime_type: "video/mp4" } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1,
            maxOutputTokens: 4000,
          },
        }),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      }
    );
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new SocialImportError("TIMEOUT", "Gemini generation timed out");
    }
    throw new SocialImportError(
      "INTERNAL",
      `Gemini request failed: ${(error as Error)?.message}`
    );
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.error("Gemini generateContent error:", response.status, errorBody);
    throw new SocialImportError("INTERNAL", `Gemini returned ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    console.error("Gemini response missing text:", JSON.stringify(data).slice(0, 500));
    throw new SocialImportError("INTERNAL", "Gemini response missing content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("Invalid Gemini JSON:", text.slice(0, 500));
    throw new SocialImportError("INTERNAL", "Gemini returned invalid JSON");
  }

  const result = parsed as { found?: unknown; recipe?: unknown };
  if (result?.found !== true || !result.recipe) {
    throw new SocialImportError("NO_RECIPE_FOUND");
  }

  const recipe = normalizeImportedRecipe(result.recipe);
  if (!recipe.title || recipe.ingredients.length === 0) {
    throw new SocialImportError("NO_RECIPE_FOUND");
  }

  return recipe;
}
