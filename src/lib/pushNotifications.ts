import prisma from "./prisma";

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Send push notifications to all of a user's registered devices via Expo Push Service.
 * Silently no-ops if the user has no registered push tokens.
 */
export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; data?: Record<string, unknown> }
): Promise<void> {
  const tokens = await prisma.pushToken.findMany({
    where: { userId },
    select: { token: true },
  });

  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
    to: token,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    sound: "default",
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      console.error("Expo push API error:", response.status, await response.text());
    }
  } catch (error) {
    // Push failures should never block the main request
    console.error("Failed to send push notification:", error);
  }
}

/**
 * Send push notifications to multiple users at once.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: { title: string; body: string; data?: Record<string, unknown> }
): Promise<void> {
  const tokens = await prisma.pushToken.findMany({
    where: { userId: { in: userIds } },
    select: { token: true },
  });

  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
    to: token,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    sound: "default",
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      console.error("Expo push API error:", response.status, await response.text());
    }
  } catch (error) {
    console.error("Failed to send push notifications:", error);
  }
}
