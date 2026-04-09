import { PrismaClient } from "@prisma/client";
import { sendPushToUser } from "./pushNotifications";

const basePrisma = new PrismaClient();

const prisma = basePrisma.$extends({
  query: {
    notification: {
      async create({ args, query }) {
        const result = await query(args);

        // Fire push notification in the background (never block the response)
        const receiverId = args.data.receiverId as string;
        const title = args.data.title as string;
        const message = args.data.message as string;
        const type = args.data.type as string;

        sendPushToUser(receiverId, {
          title,
          body: message,
          data: {
            type,
            notificationId: result.id,
            ...(args.data.data ? JSON.parse(args.data.data as string) : {}),
          },
        }).catch((err) => console.error("Push notification failed:", err));

        return result;
      },
    },
  },
});

export default prisma;
