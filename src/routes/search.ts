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
  escapeLikePattern,
  candidatePoolSize,
  MIN_QUERY_LENGTH,
} from "../lib/searchScoring";

const router = Router();

// ============================================================================
// DB-side relevance ranking (pg_trgm)
// ============================================================================
//
// These helpers pick WHICH rows enter the in-memory scoring window, ordered by
// trigram similarity so the most relevant matches are always present (the old
// `updatedAt`-ordered window could miss the best matches entirely). They return
// only ids; the caller re-hydrates through Prisma with the full access-control
// `where`, so Prisma remains the authoritative access gate and a bug here can
// at worst shorten a page, never leak a private row.
//
// Requires the pg_trgm extension + trigram GIN indexes (see prisma/schema.prisma
// and the accompanying migration). similarity()/ILIKE will error until migrated.

async function rankUserIds(
  query: string,
  excludedIds: string[],
  pool: number
): Promise<string[]> {
  const like = `%${escapeLikePattern(query)}%`;
  const q = query.toLowerCase();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT uid AS id
    FROM "User"
    WHERE uid <> ALL(${excludedIds})
      AND (
        username ILIKE ${like}
        OR "firstName" ILIKE ${like}
        OR "lastName" ILIKE ${like}
      )
    ORDER BY GREATEST(
      similarity(lower(coalesce(username, '')), ${q}),
      similarity(lower(concat_ws(' ', "firstName", "lastName")), ${q})
    ) DESC, uid ASC
    LIMIT ${pool}
  `;
  return rows.map((r) => r.id);
}

async function rankRecipeIds(
  query: string,
  blockedPeerIds: string[],
  accessibleDishListIds: string[],
  pool: number
): Promise<string[]> {
  const like = `%${escapeLikePattern(query)}%`;
  const q = query.toLowerCase();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT r.id AS id
    FROM "Recipe" r
    WHERE r."creatorId" <> ALL(${blockedPeerIds})
      AND EXISTS (
        SELECT 1 FROM "DishListRecipe" dlr
        WHERE dlr."recipeId" = r.id
          AND dlr."dishListId" = ANY(${accessibleDishListIds})
      )
      AND (
        r.title ILIKE ${like}
        OR r.description ILIKE ${like}
        OR ${query} = ANY(r.tags)
        OR ${q} = ANY(r.tags)
      )
    ORDER BY GREATEST(
      similarity(lower(r.title), ${q}),
      similarity(lower(coalesce(r.description, '')), ${q})
    ) DESC, r.id ASC
    LIMIT ${pool}
  `;
  return rows.map((r) => r.id);
}

async function rankDishListIds(
  query: string,
  accessibleDishListIds: string[],
  pool: number
): Promise<string[]> {
  const like = `%${escapeLikePattern(query)}%`;
  const q = query.toLowerCase();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id AS id
    FROM "DishList" d
    WHERE d.id = ANY(${accessibleDishListIds})
      AND (
        d.title ILIKE ${like}
        OR EXISTS (
          SELECT 1 FROM "User" u
          WHERE u.uid = d."ownerId"
            AND (
              u.username ILIKE ${like}
              OR u."firstName" ILIKE ${like}
              OR u."lastName" ILIKE ${like}
            )
        )
        OR EXISTS (
          SELECT 1 FROM "DishListRecipe" dlr
          JOIN "Recipe" rr ON rr.id = dlr."recipeId"
          WHERE dlr."dishListId" = d.id AND rr.title ILIKE ${like}
        )
      )
    ORDER BY similarity(lower(d.title), ${q}) DESC, d.id ASC
    LIMIT ${pool}
  `;
  return rows.map((r) => r.id);
}

/**
 * Apply cursor pagination over an already-scored+sorted list. When the cursor
 * is not found in the current window (e.g. it belongs past the fetched
 * candidate window), return [] to signal end-of-list rather than falling back
 * to the first page, which would duplicate results and loop load-more forever.
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

    // Below the minimum length the filtered tabs would scan near-everything and
    // return window-limited noise, so return empty (client shows a hint).
    if (query.length < MIN_QUERY_LENGTH) {
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

    // The set of DishLists the caller may see. Computed once via Prisma (the
    // authoritative access filter) and reused for both recipe and DishList
    // ranking/hydration. Following never grants access to a private DishList.
    const accessibleDishLists = await prisma.dishList.findMany({
      where: {
        AND: [
          {
            OR: [
              { visibility: "PUBLIC" },
              { ownerId: userId },
              { collaborators: { some: { userId } } },
            ],
          },
          { ownerId: { notIn: blockedPeerIds } },
        ],
      },
      select: { id: true },
    });
    const accessibleDishListIds = accessibleDishLists.map((d) => d.id);

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
          blockedPeerIds,
          accessibleDishListIds,
          true,
          10
        ),
        searchDishLists(
          query,
          userId,
          followingIds,
          followedDishListIds,
          blockedPeerIds,
          accessibleDishListIds,
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
        blockedPeerIds,
        accessibleDishListIds,
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
        accessibleDishListIds,
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
  blockedPeerIds: string[],
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredUser[]> {
  const minScore = isAllTab ? 30 : 40;
  const excludedIds = [currentUserId, ...blockedPeerIds];

  // Relevance-ranked candidate window (ids only, access-scoped in SQL).
  const rankedIds = await rankUserIds(
    query,
    excludedIds,
    candidatePoolSize(limit)
  );
  if (rankedIds.length === 0) return [];

  // Hydrate through Prisma (authoritative access gate; excludedIds re-applied).
  const users = await prisma.user.findMany({
    where: { uid: { in: rankedIds, notIn: excludedIds } },
    select: {
      uid: true,
      username: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
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
  blockedPeerIds: string[],
  accessibleDishListIds: string[],
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredRecipe[]> {
  const minScore = 30;

  // Relevance-ranked candidate window (ids only, access-scoped in SQL).
  const rankedIds = await rankRecipeIds(
    query,
    blockedPeerIds,
    accessibleDishListIds,
    candidatePoolSize(limit)
  );
  if (rankedIds.length === 0) return [];

  // Hydrate through Prisma. The access-control `where` is re-applied here so
  // Prisma stays authoritative: a stale follower row must not make the list or
  // its recipes searchable.
  const recipes = await prisma.recipe.findMany({
    where: {
      id: { in: rankedIds },
      creatorId: { notIn: blockedPeerIds },
      dishLists: {
        some: {
          dishListId: { in: accessibleDishListIds },
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
  accessibleDishListIds: string[],
  isAllTab: boolean,
  limit: number,
  cursor?: string
): Promise<ScoredDishList[]> {
  const minScore = isAllTab ? 30 : 35;

  // Relevance-ranked candidate window (ids only, access-scoped in SQL).
  const rankedIds = await rankDishListIds(
    query,
    accessibleDishListIds,
    candidatePoolSize(limit)
  );
  if (rankedIds.length === 0) return [];

  // Hydrate through Prisma. rankedIds are already access-scoped; the ACL is
  // re-applied here as defense-in-depth so Prisma stays authoritative.
  const dishLists = await prisma.dishList.findMany({
    where: {
      AND: [
        { id: { in: rankedIds } },
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
