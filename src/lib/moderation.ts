import prisma from "./prisma";
import type { Response } from "express";

type ModerationTargetType = "USER" | "DISHLIST" | "RECIPE" | "IMAGE";
type ModerationInputType = "TEXT" | "IMAGE";

const MODERATION_MODEL =
  process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest";
const MODERATION_TIMEOUT_MS = Number(
  process.env.MODERATION_TIMEOUT_MS || 6000
);

export class ModerationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ModerationError";
    this.statusCode = statusCode;
  }
}

interface ModerationContext {
  targetType: ModerationTargetType;
  targetId?: string;
  userId?: string;
}

interface TextField {
  label: string;
  value: unknown;
}

interface OpenAIModerationResult {
  flagged: boolean;
  categories?: Record<string, boolean>;
  category_scores?: Record<string, number>;
}

interface OpenAIModerationResponse {
  results?: OpenAIModerationResult[];
}

function isModerationDisabled() {
  return process.env.MODERATION_DISABLED === "true";
}

function flattenText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(flattenText);
  }

  if (value && typeof value === "object") {
    const maybeText = (value as { text?: unknown }).text;
    return typeof maybeText === "string" ? flattenText(maybeText) : [];
  }

  return [];
}

function buildLabeledText(fields: TextField[]) {
  return fields
    .flatMap((field) =>
      flattenText(field.value).map((value) => `${field.label}: ${value}`)
    )
    .join("\n");
}

async function callModerationApi(input: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODERATION_MODEL,
        input,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.error("Moderation API error:", response.status, errorBody);
      throw new ModerationError(
        "Unable to verify content right now. Please try again.",
        503
      );
    }

    return (await response.json()) as OpenAIModerationResponse;
  } catch (error) {
    if (error instanceof ModerationError) {
      throw error;
    }

    console.error("Moderation request failed:", error);
    throw new ModerationError(
      "Unable to verify content right now. Please try again.",
      503
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function recordModerationReview(
  context: ModerationContext,
  inputType: ModerationInputType,
  status: "APPROVED" | "REJECTED" | "ERROR",
  result?: OpenAIModerationResult,
  reason?: string
) {
  try {
    await prisma.moderationReview.create({
      data: {
        targetType: context.targetType,
        targetId: context.targetId,
        userId: context.userId,
        provider: "openai",
        model: MODERATION_MODEL,
        inputType,
        status,
        categories: result?.categories || undefined,
        scores: result?.category_scores || undefined,
        reason,
      },
    });
  } catch (error) {
    console.error("Failed to record moderation review:", error);
  }
}

async function assertAllowed(
  context: ModerationContext,
  inputType: ModerationInputType,
  response: OpenAIModerationResponse
) {
  const result = response.results?.[0];

  if (!result) {
    await recordModerationReview(
      context,
      inputType,
      "ERROR",
      undefined,
      "Missing moderation result"
    );
    throw new ModerationError(
      "Unable to verify content right now. Please try again.",
      503
    );
  }

  if (result.flagged) {
    await recordModerationReview(
      context,
      inputType,
      "REJECTED",
      result,
      "Flagged by moderation provider"
    );
    throw new ModerationError(
      "This content can't be posted. Please edit it and try again."
    );
  }

  await recordModerationReview(context, inputType, "APPROVED", result);
}

export async function moderateTextFields(
  fields: TextField[],
  context: ModerationContext
) {
  if (isModerationDisabled()) return;

  const inputText = buildLabeledText(fields);
  if (!inputText) return;

  const response = await callModerationApi(inputText);
  await assertAllowed(context, "TEXT", response);
}

export async function moderateImage(
  dataUrl: string,
  context: ModerationContext
) {
  if (isModerationDisabled()) return;

  const response = await callModerationApi([
    {
      type: "image_url",
      image_url: {
        url: dataUrl,
      },
    },
  ]);
  await assertAllowed(context, "IMAGE", response);
}

export function handleModerationError(error: unknown, res: Response) {
  if (error instanceof ModerationError) {
    res.status(error.statusCode).json({ error: error.message });
    return true;
  }

  return false;
}
