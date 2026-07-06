import prisma from "./prisma";
import { chunkArray } from "./notificationHelpers";

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
}

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Expo rejects requests with more than 100 messages.
const EXPO_PUSH_BATCH_SIZE = 100;

async function sendToTokens(tokens: string[], payload: PushPayload): Promise<void> {
  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = tokens.map((token) => ({
    to: token,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    sound: "default",
  }));

  for (const batch of chunkArray(messages, EXPO_PUSH_BATCH_SIZE)) {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        console.error("Expo push API error:", response.status, await response.text());
      }
    } catch (error) {
      // Push failures should never block the main request
      console.error("Failed to send push notification:", error);
    }
  }
}

/**
 * Send push notifications to all of a user's registered devices via Expo Push Service.
 * Silently no-ops if the user has no registered push tokens.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<void> {
  const tokens = await prisma.pushToken.findMany({
    where: { userId },
    select: { token: true },
  });

  await sendToTokens(tokens.map(({ token }) => token), payload);
}

/**
 * Send push notifications to multiple users at once.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<void> {
  const tokens = await prisma.pushToken.findMany({
    where: { userId: { in: userIds } },
    select: { token: true },
  });

  await sendToTokens(tokens.map(({ token }) => token), payload);
}
