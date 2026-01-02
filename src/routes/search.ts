import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";

const router = Router();

// ============================================================================
// Types
// ============================================================================

interface ScoredUser {
  uid: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  isFollowing: boolean;
  isMutual: boolean;
  score: number;
}

interface ScoredRecipe {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  prepTime: number | null;
  cookTime: number | null;
  servings: number | null;
  tags: string[];
  creatorId: string;
  creator: {
    uid: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  score: number;
}

interface ScoredDishList {
  id: string;
  title: string;
  description: string | null;
  visibility: string;
  recipeCount: number;
  followerCount: number;
  owner: {
    uid: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  isFollowing: boolean;
  isCollaborator: boolean;
  score: number;
}

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Calculate base relevance score for text matching
 */
function calculateTextScore(
  query: string,
  text: string | null,
  weights: {
    exact: number;
    startsWith: number;
    wordMatch: number;
    contains: number;
  }
): number {
  if (!text) return 0;

  const normalizedQuery = query.toLowerCase().trim();
  const normalizedText = text.toLowerCase().trim();

  // Exact match
  if (normalizedText === normalizedQuery) {
    return weights.exact;
  }

  // Starts with query
  if (normalizedText.startsWith(normalizedQuery)) {
    return weights.startsWith;
  }

  // Full word match (query appears as complete word)
  const wordBoundaryRegex = new RegExp(
    `\\b${escapeRegex(normalizedQuery)}\\b`,
    "i"
  );
  if (wordBoundaryRegex.test(normalizedText)) {
    return weights.wordMatch;
  }

  // Contains query
  if (normalizedText.includes(normalizedQuery)) {
    return weights.contains;
  }

  return 0;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Calculate popularity boost (logarithmic, capped)
 */
function calculatePopularityBoost(count: number, maxBoost: number): number {
  if (count <= 0) return 0;
  return Math.min(maxBoost, Math.log10(count + 1) * 3);
}

/**
 * Calculate recency boost (within last 30 days)
 */
function calculateRecencyBoost(updatedAt: Date, maxBoost: number): number {
  const daysSinceUpdate =
    (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate > 30) return 0;
  return maxBoost * (1 - daysSinceUpdate / 30);
}

// ============================================================================
// User Scoring (for USERS tab and ALL tab)
// ============================================================================

function scoreUser(
  user: any,
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  followerIds: Set<string>,
  isAllTab: boolean
): ScoredUser {
  let score = 0;

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ");

  // Name/username matching
  score += calculateTextScore(query, displayName, {
    exact: 100,
    startsWith: 90,
    wordMatch: 80,
    contains: 60,
  });

  score += calculateTextScore(query, user.username, {
    exact: 100,
    startsWith: 70,
    wordMatch: 65,
    contains: 50,
  });

  // Social boosts
  const isFollowing = followingIds.has(user.uid);
  const isMutual = isFollowing && followerIds.has(user.uid);

  if (isAllTab) {
    // Social boosts only apply on ALL tab with base relevance >= 50
    if (score >= 50) {
      if (isMutual) {
        score += 20;
      } else if (isFollowing) {
        score += 15;
      }
    }
  } else {
    // USERS tab: stronger social boosts, always rank followed above non-followed
    if (isMutual) {
      score += 40;
    } else if (isFollowing) {
      score += 30;
    }
  }

  return {
    uid: user.uid,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    isFollowing,
    isMutual,
    score,
  };
}

// ============================================================================
// Recipe Scoring (for RECIPES tab and ALL tab)
// ============================================================================

function scoreRecipe(
  recipe: any,
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  savedRecipeIds: Set<string>,
  isAllTab: boolean
): ScoredRecipe {
  let score = 0;

  // Title matching (primary signal)
  score += calculateTextScore(query, recipe.title, {
    exact: 100,
    startsWith: 90,
    wordMatch: 80,
    contains: 60,
  });

  // Tag matching
  if (recipe.tags && Array.isArray(recipe.tags)) {
    for (const tag of recipe.tags) {
      const tagScore = calculateTextScore(query, tag, {
        exact: 50,
        startsWith: 40,
        wordMatch: 35,
        contains: 25,
      });
      if (tagScore > 0) {
        score += tagScore;
        break; // Only count best tag match
      }
    }
  }

  // Ingredient matching
  if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
    for (let i = 0; i < recipe.ingredients.length; i++) {
      const ingredient = recipe.ingredients[i];
      const ingredientText =
        typeof ingredient === "string" ? ingredient : ingredient?.text;
      if (ingredientText) {
        const isTopIngredient = i < 3;
        const ingredientScore = calculateTextScore(query, ingredientText, {
          exact: isTopIngredient ? 45 : 25,
          startsWith: isTopIngredient ? 40 : 20,
          wordMatch: isTopIngredient ? 35 : 18,
          contains: isTopIngredient ? 25 : 12,
        });
        if (ingredientScore > 0) {
          score += ingredientScore;
          break; // Only count best ingredient match
        }
      }
    }
  }

  // Description matching (secondary)
  score += calculateTextScore(query, recipe.description, {
    exact: 25,
    startsWith: 20,
    wordMatch: 18,
    contains: 15,
  });

  // Author matching (light weight on RECIPES tab)
  const creatorName = [recipe.creator?.firstName, recipe.creator?.lastName]
    .filter(Boolean)
    .join(" ");
  score += calculateTextScore(query, creatorName, {
    exact: 20,
    startsWith: 15,
    wordMatch: 12,
    contains: 8,
  });

  // Social boosts (only on ALL tab, capped at +10)
  if (isAllTab && score >= 50) {
    let socialBoost = 0;

    if (savedRecipeIds.has(recipe.id)) {
      socialBoost += 10;
    }
    if (followingIds.has(recipe.creatorId)) {
      socialBoost += 6;
    }

    score += Math.min(10, socialBoost);
  } else if (!isAllTab) {
    // RECIPES tab: lighter social signals
    if (savedRecipeIds.has(recipe.id)) {
      score += 15;
    }
    if (followingIds.has(recipe.creatorId)) {
      score += 10;
    }
  }

  // Recency boost (tie-breaker, capped at +5)
  score += calculateRecencyBoost(recipe.updatedAt, 5);

  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    imageUrl: recipe.imageUrl,
    prepTime: recipe.prepTime,
    cookTime: recipe.cookTime,
    servings: recipe.servings,
    tags: recipe.tags || [],
    creatorId: recipe.creatorId,
    creator: recipe.creator,
    score,
  };
}

// ============================================================================
// DishList Scoring (for DISHLISTS tab and ALL tab)
// ============================================================================

function scoreDishList(
  dishList: any,
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  followedDishListIds: Set<string>,
  isAllTab: boolean
): ScoredDishList {
  let score = 0;

  // Title matching (primary signal)
  score += calculateTextScore(query, dishList.title, {
    exact: 100,
    startsWith: 90,
    wordMatch: 80,
    contains: 60,
  });

  // Creator matching
  const ownerName = [dishList.owner?.firstName, dishList.owner?.lastName]
    .filter(Boolean)
    .join(" ");
  score += calculateTextScore(query, ownerName, {
    exact: 60,
    startsWith: 50,
    wordMatch: 45,
    contains: 35,
  });

  score += calculateTextScore(query, dishList.owner?.username, {
    exact: 55,
    startsWith: 45,
    wordMatch: 40,
    contains: 30,
  });

  // Collaborator matching
  if (dishList.collaborators && Array.isArray(dishList.collaborators)) {
    for (const collab of dishList.collaborators) {
      const collabName = [collab.user?.firstName, collab.user?.lastName]
        .filter(Boolean)
        .join(" ");
      const collabScore = calculateTextScore(query, collabName, {
        exact: 35,
        startsWith: 30,
        wordMatch: 25,
        contains: 20,
      });
      if (collabScore > 0) {
        score += collabScore;
        break;
      }
    }
  }

  // Recipe titles inside DishList (secondary)
  if (dishList.recipes && Array.isArray(dishList.recipes)) {
    for (const dlRecipe of dishList.recipes) {
      const recipeTitle = dlRecipe.recipe?.title;
      const recipeScore = calculateTextScore(query, recipeTitle, {
        exact: 35,
        startsWith: 30,
        wordMatch: 25,
        contains: 18,
      });
      if (recipeScore > 0) {
        score += recipeScore;
        break; // Only count best recipe title match
      }
    }
  }

  // Recipe ingredients inside DishList (secondary)
  if (dishList.recipes && Array.isArray(dishList.recipes)) {
    let foundIngredientMatch = false;
    for (const dlRecipe of dishList.recipes) {
      const ingredients = dlRecipe.recipe?.ingredients;
      if (ingredients && Array.isArray(ingredients)) {
        for (const ingredient of ingredients) {
          const ingredientText =
            typeof ingredient === "string" ? ingredient : ingredient?.text;
          if (ingredientText) {
            const ingredientScore = calculateTextScore(query, ingredientText, {
              exact: 30,
              startsWith: 25,
              wordMatch: 20,
              contains: 15,
            });
            if (ingredientScore > 0) {
              score += ingredientScore;
              foundIngredientMatch = true;
              break; // Only count best ingredient match per recipe
            }
          }
        }
        if (foundIngredientMatch) break; // Only count one recipe's ingredient match
      }
    }
  }

  // Description matching
  score += calculateTextScore(query, dishList.description, {
    exact: 25,
    startsWith: 20,
    wordMatch: 18,
    contains: 15,
  });

  const isFollowing = followedDishListIds.has(dishList.id);
  const isCollaborator = dishList.collaborators?.some(
    (c: any) => c.userId === currentUserId
  );

  // Social boosts
  if (isAllTab && score >= 50) {
    let socialBoost = 0;

    if (isFollowing) {
      socialBoost += 10;
    }
    if (followingIds.has(dishList.ownerId)) {
      socialBoost += 8;
    }

    score += Math.min(10, socialBoost);
  } else if (!isAllTab) {
    // DISHLISTS tab
    if (isFollowing) {
      score += 20;
    }
  }

  // Popularity boost (follower count, logarithmic, capped at +15)
  const followerCount = dishList._count?.followers || 0;
  if (score >= 50 || !isAllTab) {
    score += calculatePopularityBoost(followerCount, 15);
  }

  // Recency boost
  score += calculateRecencyBoost(dishList.updatedAt, 5);

  return {
    id: dishList.id,
    title: dishList.title,
    description: dishList.description,
    visibility: dishList.visibility,
    recipeCount: dishList._count?.recipes || 0,
    followerCount,
    owner: dishList.owner,
    isFollowing,
    isCollaborator: isCollaborator || false,
    score,
  };
}

// ============================================================================
// Main Search Endpoint
// ============================================================================

router.get("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const {
      q = "",
      tab = "all",
      cursor,
      limit = "20",
    } = req.query as {
      q?: string;
      tab?: "all" | "users" | "recipes" | "dishlists";
      cursor?: string;
      limit?: string;
    };

    const query = (q as string).trim();
    const pageLimit = Math.min(parseInt(limit as string) || 20, 50);

    // If no query, return empty results
    if (!query) {
      return res.json({
        users: [],
        recipes: [],
        dishLists: [],
        nextCursor: null,
      });
    }

    // Fetch user's social graph for scoring
    const [followingRelations, followerRelations, followedDishLists] =
      await Promise.all([
        prisma.userFollow.findMany({
          where: { followerId: userId },
          select: { followingId: true },
        }),
        prisma.userFollow.findMany({
          where: { followingId: userId },
          select: { followerId: true },
        }),
        prisma.dishListFollower.findMany({
          where: { userId },
          select: { dishListId: true },
        }),
      ]);

    const followingIds = new Set(followingRelations.map((f) => f.followingId));
    const followerIds = new Set(followerRelations.map((f) => f.followerId));
    const followedDishListIds = new Set(
      followedDishLists.map((f) => f.dishListId)
    );

    // For recipe scoring, we need saved recipes (recipes in user's DishLists)
    const userDishListRecipes = await prisma.dishListRecipe.findMany({
      where: {
        dishList: {
          OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
        },
      },
      select: { recipeId: true },
    });
    const savedRecipeIds = new Set(userDishListRecipes.map((r) => r.recipeId));

    const isAllTab = tab === "all";

    // Build response based on tab
    if (tab === "all") {
      // ALL tab: fetch limited results from each category
      const [users, recipes, dishLists] = await Promise.all([
        searchUsers(query, userId, followingIds, followerIds, true, 10),
        searchRecipes(
          query,
          userId,
          followingIds,
          savedRecipeIds,
          followedDishListIds,
          true,
          10
        ),
        searchDishLists(
          query,
          userId,
          followingIds,
          followedDishListIds,
          true,
          10
        ),
      ]);

      // Apply category normalization for ALL tab
      const normalizedUsers = users.map((u) => ({
        ...u,
        score: u.score * 1.0,
      }));
      const normalizedRecipes = recipes.map((r) => ({
        ...r,
        score: r.score * 0.9,
      }));
      const normalizedDishLists = dishLists.map((d) => ({
        ...d,
        score: d.score * 0.95,
      }));

      return res.json({
        users: normalizedUsers,
        recipes: normalizedRecipes,
        dishLists: normalizedDishLists,
        nextCursor: null, // ALL tab doesn't paginate
      });
    }

    // Filtered tabs: paginated results
    if (tab === "users") {
      const users = await searchUsers(
        query,
        userId,
        followingIds,
        followerIds,
        false,
        pageLimit + 1, // Fetch one extra to check for more
        cursor
      );

      const hasMore = users.length > pageLimit;
      const results = hasMore ? users.slice(0, pageLimit) : users;
      const nextCursor = hasMore ? results[results.length - 1].uid : null;

      return res.json({
        users: results,
        recipes: [],
        dishLists: [],
        nextCursor,
      });
    }

    if (tab === "recipes") {
      const recipes = await searchRecipes(
        query,
        userId,
        followingIds,
        savedRecipeIds,
        followedDishListIds,
        false,
        pageLimit + 1,
        cursor
      );

      const hasMore = recipes.length > pageLimit;
      const results = hasMore ? recipes.slice(0, pageLimit) : recipes;
      const nextCursor = hasMore ? results[results.length - 1].id : null;

      return res.json({
        users: [],
        recipes: results,
        dishLists: [],
        nextCursor,
      });
    }

    if (tab === "dishlists") {
      const dishLists = await searchDishLists(
        query,
        userId,
        followingIds,
        followedDishListIds,
        false,
        pageLimit + 1,
        cursor
      );

      const hasMore = dishLists.length > pageLimit;
      const results = hasMore ? dishLists.slice(0, pageLimit) : dishLists;
      const nextCursor = hasMore ? results[results.length - 1].id : null;

      return res.json({
        users: [],
        recipes: [],
        dishLists: results,
        nextCursor,
      });
    }

    return res.json({
      users: [],
      recipes: [],
      dishLists: [],
      nextCursor: null,
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
});

// ============================================================================
// Search Helper Functions
// ============================================================================

async function searchUsers(
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  followerIds: Set<string>,
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredUser[]> {
  const minScore = isAllTab ? 30 : 40;

  // Search users by name or username
  const users = await prisma.user.findMany({
    where: {
      uid: { not: currentUserId }, // Exclude self
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { firstName: { contains: query, mode: "insensitive" } },
        { lastName: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      uid: true,
      username: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
    take: limit * 3, // Fetch more to account for filtering after scoring
  });

  // Score and filter
  const scored = users
    .map((user) =>
      scoreUser(user, query, currentUserId, followingIds, followerIds, isAllTab)
    )
    .filter((u) => u.score >= minScore)
    .sort((a, b) => {
      // Primary: score descending
      if (b.score !== a.score) return b.score - a.score;
      // Secondary: followed users first (for USERS tab)
      if (!isAllTab) {
        if (a.isFollowing !== b.isFollowing) return a.isFollowing ? -1 : 1;
      }
      // Tertiary: alphabetical by username
      return (a.username || "").localeCompare(b.username || "");
    });

  // Apply cursor-based pagination
  if (cursor) {
    const cursorIndex = scored.findIndex((u) => u.uid === cursor);
    if (cursorIndex !== -1) {
      return scored.slice(cursorIndex + 1, cursorIndex + 1 + limit);
    }
  }

  return scored.slice(0, limit);
}

async function searchRecipes(
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  savedRecipeIds: Set<string>,
  followedDishListIds: Set<string>,
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredRecipe[]> {
  const minScore = 30;

  // Get accessible DishList IDs (public, followed, or collaborator)
  const accessibleDishLists = await prisma.dishList.findMany({
    where: {
      OR: [
        { visibility: "PUBLIC" },
        { ownerId: currentUserId },
        { collaborators: { some: { userId: currentUserId } } },
        { followers: { some: { userId: currentUserId } } },
      ],
    },
    select: { id: true },
  });
  const accessibleDishListIds = new Set(accessibleDishLists.map((d) => d.id));

  // Search recipes
  const recipes = await prisma.recipe.findMany({
    where: {
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { tags: { has: query } }, // Exact tag match
        { tags: { hasSome: [query.toLowerCase()] } },
      ],
      // Must be in an accessible DishList
      dishLists: {
        some: {
          dishListId: { in: Array.from(accessibleDishListIds) },
        },
      },
    },
    include: {
      creator: {
        select: {
          uid: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    take: limit * 3,
  });

  // Score and filter
  const scored = recipes
    .map((recipe) =>
      scoreRecipe(
        recipe,
        query,
        currentUserId,
        followingIds,
        savedRecipeIds,
        isAllTab
      )
    )
    .filter((r) => r.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id); // Stable sort
    });

  // Apply cursor-based pagination
  if (cursor) {
    const cursorIndex = scored.findIndex((r) => r.id === cursor);
    if (cursorIndex !== -1) {
      return scored.slice(cursorIndex + 1, cursorIndex + 1 + limit);
    }
  }

  return scored.slice(0, limit);
}

async function searchDishLists(
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  followedDishListIds: Set<string>,
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredDishList[]> {
  const minScore = isAllTab ? 30 : 35;

  // Search DishLists (only public OR ones user has access to)
  const dishLists = await prisma.dishList.findMany({
    where: {
      AND: [
        // Access control
        {
          OR: [
            { visibility: "PUBLIC" },
            { ownerId: currentUserId },
            { collaborators: { some: { userId: currentUserId } } },
            { followers: { some: { userId: currentUserId } } },
          ],
        },
        // Search criteria
        {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { description: { contains: query, mode: "insensitive" } },
            {
              owner: {
                OR: [
                  { username: { contains: query, mode: "insensitive" } },
                  { firstName: { contains: query, mode: "insensitive" } },
                  { lastName: { contains: query, mode: "insensitive" } },
                ],
              },
            },
            {
              recipes: {
                some: {
                  recipe: {
                    title: { contains: query, mode: "insensitive" },
                  },
                },
              },
            },
          ],
        },
      ],
    },
    include: {
      owner: {
        select: {
          uid: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      collaborators: {
        select: {
          userId: true,
          user: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      recipes: {
        take: 10,
        select: {
          recipe: {
            select: {
              title: true,
              ingredients: true, // Include ingredients for scoring
            },
          },
        },
      },
      _count: {
        select: {
          recipes: true,
          followers: true,
        },
      },
    },
    take: limit * 3,
  });

  // Score and filter
  const scored = dishLists
    .map((dishList) =>
      scoreDishList(
        dishList,
        query,
        currentUserId,
        followingIds,
        followedDishListIds,
        isAllTab
      )
    )
    .filter((d) => d.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id); // Stable sort
    });

  // Apply cursor-based pagination
  if (cursor) {
    const cursorIndex = scored.findIndex((d) => d.id === cursor);
    if (cursorIndex !== -1) {
      return scored.slice(cursorIndex + 1, cursorIndex + 1 + limit);
    }
  }

  return scored.slice(0, limit);
}

export default router;
