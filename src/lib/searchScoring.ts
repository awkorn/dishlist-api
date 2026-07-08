// Pure, side-effect-free helpers for the search endpoint: request-param
// normalization and the relevance scoring functions. Kept dependency-free so
// they can be unit tested directly (see __tests__/searchScoring.test.ts). The
// route handler in routes/search.ts does the DB work and pagination.

export type SearchTab = "all" | "users" | "recipes" | "dishlists";

export const VALID_TABS: readonly SearchTab[] = [
  "all",
  "users",
  "recipes",
  "dishlists",
];

export const MAX_QUERY_LENGTH = 100;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;

// ============================================================================
// Request param normalization
// ============================================================================

/**
 * Express query params can be a string, an array (e.g. `?q=a&q=b`), or an
 * object. Coerce to a single trimmed string so downstream string ops can't
 * throw on a non-string value.
 */
export function coerceQueryString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string");
    return typeof first === "string" ? first.trim() : "";
  }
  return "";
}

/** Cap the search text at MAX_QUERY_LENGTH after coercion. */
export function normalizeSearchQuery(value: unknown): string {
  return coerceQueryString(value).slice(0, MAX_QUERY_LENGTH);
}

/** Unknown/invalid tabs fall back to "all". */
export function normalizeTab(value: unknown): SearchTab {
  return VALID_TABS.includes(value as SearchTab)
    ? (value as SearchTab)
    : "all";
}

/** Parse the page limit, clamping to [1, MAX_PAGE_LIMIT]. */
export function normalizePageLimit(value: unknown): number {
  const raw = parseInt(coerceQueryString(value), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(raw, MAX_PAGE_LIMIT);
}

/** Optional cursor: a single non-empty string or undefined. */
export function normalizeCursor(value: unknown): string | undefined {
  const cursor = coerceQueryString(value);
  return cursor.length > 0 ? cursor : undefined;
}

// ============================================================================
// Types
// ============================================================================

export interface ScoredUser {
  uid: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  isFollowing: boolean;
  isMutual: boolean;
  score: number;
}

export interface ScoredRecipe {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  imageUrls: string[];
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

export interface ScoredDishList {
  id: string;
  title: string;
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
export function calculateTextScore(
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
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Calculate popularity boost (logarithmic, capped)
 */
export function calculatePopularityBoost(count: number, maxBoost: number): number {
  if (count <= 0) return 0;
  return Math.min(maxBoost, Math.log10(count + 1) * 3);
}

/**
 * Calculate recency boost (within last 30 days)
 */
export function calculateRecencyBoost(updatedAt: Date, maxBoost: number): number {
  const daysSinceUpdate =
    (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate > 30) return 0;
  return maxBoost * (1 - daysSinceUpdate / 30);
}

// ============================================================================
// User Scoring (for USERS tab and ALL tab)
// ============================================================================

export function scoreUser(
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

export function scoreRecipe(
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
    imageUrls: (recipe as any).imageUrls?.length
      ? (recipe as any).imageUrls
      : recipe.imageUrl
        ? [recipe.imageUrl]
        : [],
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

export function scoreDishList(
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
    visibility: dishList.visibility,
    recipeCount: dishList._count?.recipes || 0,
    followerCount,
    owner: dishList.owner,
    isFollowing,
    isCollaborator: isCollaborator || false,
    score,
  };
}
