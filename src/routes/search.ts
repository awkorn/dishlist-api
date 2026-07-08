import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";
import { getBlockedPeerIds } from "../lib/blocks";
import { searchLimiter } from "../middleware/rateLimit";
import {
  ScoredUser,
  ScoredRecipe,
  ScoredDishList,
  scoreUser,
  scoreRecipe,
  scoreDishList,
  normalizeSearchQuery,
  normalizeTab,
  normalizePageLimit,
  normalizeCursor,
} from "../lib/searchScoring";

const router = Router();

// ============================================================================
// Main Search Endpoint
// ============================================================================

router.get("/", authToken, searchLimiter, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    // Normalize request params: coerce array-valued params, cap query length,
    // clamp the page limit, and fall back to the "all" tab for unknown values.
    const query = normalizeSearchQuery(req.query.q);
    const tab = normalizeTab(req.query.tab);
    const cursor = normalizeCursor(req.query.cursor);
    const pageLimit = normalizePageLimit(req.query.limit);

    // If no query, return empty results
    if (!query) {
      return res.json({
        users: [],
        recipes: [],
        dishLists: [],
        nextCursor: null,
      });
    }

    const blockedPeerIds = await getBlockedPeerIds(userId);

    // Fetch user's social graph for scoring
    const [followingRelations, followerRelations, followedDishLists] =
      await Promise.all([
        prisma.userFollow.findMany({
          where: { followerId: userId, followingId: { notIn: blockedPeerIds } },
          select: { followingId: true },
        }),
        prisma.userFollow.findMany({
          where: { followingId: userId, followerId: { notIn: blockedPeerIds } },
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

    // Build response based on tab
    if (tab === "all") {
      // ALL tab: fetch limited results from each category
      const [users, recipes, dishLists] = await Promise.all([
        searchUsers(query, userId, followingIds, followerIds, blockedPeerIds, true, 10),
        searchRecipes(
          query,
          userId,
          followingIds,
          savedRecipeIds,
          followedDishListIds,
          blockedPeerIds,
          true,
          10
        ),
        searchDishLists(
          query,
          userId,
          followingIds,
          followedDishListIds,
          blockedPeerIds,
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
        blockedPeerIds,
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
        blockedPeerIds,
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
        blockedPeerIds,
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

/**
 * Apply cursor pagination over an already-scored+sorted list. When the cursor
 * is not found in the current window (e.g. it belongs past the fetched
 * `take` window), return [] to signal end-of-list rather than falling back to
 * the first page, which would duplicate results and loop load-more forever.
 */
function paginateScored<T>(
  scored: T[],
  limit: number,
  getId: (item: T) => string,
  cursor?: string
): T[] {
  if (cursor) {
    const cursorIndex = scored.findIndex((item) => getId(item) === cursor);
    if (cursorIndex === -1) {
      return [];
    }
    return scored.slice(cursorIndex + 1, cursorIndex + 1 + limit);
  }

  return scored.slice(0, limit);
}

async function searchUsers(
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  followerIds: Set<string>,
  blockedPeerIds: string[],
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredUser[]> {
  const minScore = isAllTab ? 30 : 40;

  // Search users by name or username
  const users = await prisma.user.findMany({
    where: {
      uid: { notIn: [currentUserId, ...blockedPeerIds] },
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
    // Stable ordering so the fetched window and cross-page results are
    // deterministic (in-memory scoring re-runs this fetch on every page).
    orderBy: [{ username: "asc" }, { uid: "asc" }],
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

  return paginateScored(scored, limit, (u) => u.uid, cursor);
}

async function searchRecipes(
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  savedRecipeIds: Set<string>,
  followedDishListIds: Set<string>,
  blockedPeerIds: string[],
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredRecipe[]> {
  const minScore = 30;

  // Following never grants access to a private DishList. A stale follower row
  // must not make the list or its recipes searchable.
  const accessibleDishLists = await prisma.dishList.findMany({
    where: {
      AND: [
        {
          OR: [
            { visibility: "PUBLIC" },
            { ownerId: currentUserId },
            { collaborators: { some: { userId: currentUserId } } },
          ],
        },
        { ownerId: { notIn: blockedPeerIds } },
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
      creatorId: { notIn: blockedPeerIds },
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
    // Stable ordering so the fetched window and cross-page results are
    // deterministic (in-memory scoring re-runs this fetch on every page).
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
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

  return paginateScored(scored, limit, (r) => r.id, cursor);
}

async function searchDishLists(
  query: string,
  currentUserId: string,
  followingIds: Set<string>,
  followedDishListIds: Set<string>,
  blockedPeerIds: string[],
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
          ],
        },
        { ownerId: { notIn: blockedPeerIds } },
        // Search criteria
        {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
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
    // Stable ordering so the fetched window and cross-page results are
    // deterministic (in-memory scoring re-runs this fetch on every page).
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
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

  return paginateScored(scored, limit, (d) => d.id, cursor);
}

export default router;
