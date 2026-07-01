export const activeUserWhere = {
  status: "ACTIVE" as const,
};

export const visibleDishListWhere = {
  moderationState: "VISIBLE" as const,
  owner: activeUserWhere,
};

export const visibleRecipeWhere = {
  moderationState: "VISIBLE" as const,
  creator: activeUserWhere,
};
