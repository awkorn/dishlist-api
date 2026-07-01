import { PrismaClient } from "@prisma/client";
import { sendPushToUser } from "./pushNotifications";
import {
  activeUserWhere,
  visibleDishListWhere,
  visibleRecipeWhere,
} from "./visibility";

const basePrisma = new PrismaClient();

export const adminPrisma = basePrisma.$extends({
  name: "notification-push",
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

function appendVisibilityFilter<T>(
  where: T | undefined,
  visibility: Record<string, unknown>
) {
  return {
    AND: [where || {}, visibility],
  };
}

const prisma = adminPrisma.$extends({
  name: "consumer-visibility",
  query: {
    user: {
      async findMany({ args, query }) {
        args.where = appendVisibilityFilter(args.where, activeUserWhere);
        return query(args);
      },
      async findFirst({ args, query }) {
        args.where = appendVisibilityFilter(args.where, activeUserWhere);
        return query(args);
      },
      async findUnique({ args, query }) {
        args.where = {
          ...args.where,
          ...activeUserWhere,
        } as typeof args.where;
        return query(args);
      },
    },
    dishList: {
      async findMany({ args, query }) {
        args.where = appendVisibilityFilter(args.where, visibleDishListWhere);
        return query(args);
      },
      async findFirst({ args, query }) {
        args.where = appendVisibilityFilter(args.where, visibleDishListWhere);
        return query(args);
      },
      async findUnique({ args, query }) {
        args.where = {
          ...args.where,
          ...visibleDishListWhere,
        } as typeof args.where;
        return query(args);
      },
    },
    recipe: {
      async findMany({ args, query }) {
        args.where = appendVisibilityFilter(args.where, visibleRecipeWhere);
        return query(args);
      },
      async findFirst({ args, query }) {
        args.where = appendVisibilityFilter(args.where, visibleRecipeWhere);
        return query(args);
      },
      async findUnique({ args, query }) {
        args.where = {
          ...args.where,
          ...visibleRecipeWhere,
        } as typeof args.where;
        return query(args);
      },
    },
  },
});

export default prisma;
