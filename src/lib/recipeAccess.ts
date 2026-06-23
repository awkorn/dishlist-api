import type { Prisma } from "@prisma/client";

export function accessibleRecipeWhere(
  userId: string,
  recipeId: string
): Prisma.RecipeWhereInput {
  return {
    id: recipeId,
    OR: [
      { creatorId: userId },
      {
        dishLists: {
          some: {
            dishList: {
              visibility: "PUBLIC",
            },
          },
        },
      },
      {
        dishLists: {
          some: {
            dishList: {
              OR: [
                { ownerId: userId },
                { collaborators: { some: { userId } } },
              ],
            },
          },
        },
      },
      { shares: { some: { recipientId: userId } } },
    ],
  };
}

export function writableDishListWhere(userId: string, dishListId?: string) {
  return {
    ...(dishListId ? { id: dishListId } : {}),
    OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
  };
}
