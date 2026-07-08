import { describe, expect, it } from "vitest";
import {
  coerceQueryString,
  normalizeSearchQuery,
  normalizeTab,
  normalizePageLimit,
  normalizeCursor,
  calculateTextScore,
  calculatePopularityBoost,
  calculateRecencyBoost,
  scoreUser,
  scoreRecipe,
  scoreDishList,
  MAX_QUERY_LENGTH,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../searchScoring";

// ============================================================================
// Param normalization
// ============================================================================

describe("coerceQueryString", () => {
  it("trims a string", () => {
    expect(coerceQueryString("  hi  ")).toBe("hi");
  });

  it("takes the first string from an array param", () => {
    expect(coerceQueryString(["  a ", "b"])).toBe("a");
  });

  it("returns '' for non-string / empty inputs", () => {
    expect(coerceQueryString(undefined)).toBe("");
    expect(coerceQueryString(123)).toBe("");
    expect(coerceQueryString({})).toBe("");
    expect(coerceQueryString([{ x: 1 }])).toBe("");
  });
});

describe("normalizeSearchQuery", () => {
  it("caps at MAX_QUERY_LENGTH", () => {
    const long = "a".repeat(MAX_QUERY_LENGTH + 50);
    expect(normalizeSearchQuery(long).length).toBe(MAX_QUERY_LENGTH);
  });

  it("coerces array params instead of throwing", () => {
    expect(normalizeSearchQuery(["pasta", "x"])).toBe("pasta");
  });
});

describe("normalizeTab", () => {
  it("passes valid tabs through", () => {
    expect(normalizeTab("users")).toBe("users");
    expect(normalizeTab("dishlists")).toBe("dishlists");
  });

  it("falls back to 'all' for unknown/invalid tabs", () => {
    expect(normalizeTab("bogus")).toBe("all");
    expect(normalizeTab(undefined)).toBe("all");
    expect(normalizeTab(["users"])).toBe("all");
  });
});

describe("normalizePageLimit", () => {
  it("parses a valid limit", () => {
    expect(normalizePageLimit("15")).toBe(15);
  });

  it("clamps to MAX_PAGE_LIMIT", () => {
    expect(normalizePageLimit("999")).toBe(MAX_PAGE_LIMIT);
  });

  it("defaults on garbage / non-positive input", () => {
    expect(normalizePageLimit("nope")).toBe(DEFAULT_PAGE_LIMIT);
    expect(normalizePageLimit("0")).toBe(DEFAULT_PAGE_LIMIT);
    expect(normalizePageLimit("-5")).toBe(DEFAULT_PAGE_LIMIT);
    expect(normalizePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
  });
});

describe("normalizeCursor", () => {
  it("returns a non-empty cursor", () => {
    expect(normalizeCursor("abc")).toBe("abc");
  });

  it("returns undefined for empty/missing", () => {
    expect(normalizeCursor("")).toBeUndefined();
    expect(normalizeCursor(undefined)).toBeUndefined();
  });
});

// ============================================================================
// Scoring primitives
// ============================================================================

describe("calculateTextScore", () => {
  const weights = { exact: 100, startsWith: 90, wordMatch: 80, contains: 60 };

  it("returns 0 for null text", () => {
    expect(calculateTextScore("a", null, weights)).toBe(0);
  });

  it("scores each match tier", () => {
    expect(calculateTextScore("pasta", "pasta", weights)).toBe(100);
    expect(calculateTextScore("pas", "pasta carbonara", weights)).toBe(90);
    expect(calculateTextScore("carbonara", "pasta carbonara", weights)).toBe(
      80
    );
    expect(calculateTextScore("bona", "pasta carbonara", weights)).toBe(60);
    expect(calculateTextScore("pizza", "pasta carbonara", weights)).toBe(0);
  });

  it("is case-insensitive and does not throw on regex metacharacters", () => {
    expect(calculateTextScore("PASTA", "pasta", weights)).toBe(100);
    expect(() => calculateTextScore("a+b(", "some text", weights)).not.toThrow();
  });
});

describe("calculatePopularityBoost", () => {
  it("is 0 at or below zero", () => {
    expect(calculatePopularityBoost(0, 15)).toBe(0);
    expect(calculatePopularityBoost(-3, 15)).toBe(0);
  });

  it("grows logarithmically but is capped", () => {
    expect(calculatePopularityBoost(1_000_000, 15)).toBe(15);
    expect(calculatePopularityBoost(9, 15)).toBeCloseTo(3, 5);
  });
});

describe("calculateRecencyBoost", () => {
  it("is 0 for updates older than 30 days", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    expect(calculateRecencyBoost(old, 5)).toBe(0);
  });

  it("is near-max for a just-now update", () => {
    expect(calculateRecencyBoost(new Date(), 5)).toBeCloseTo(5, 1);
  });
});

// ============================================================================
// Entity scoring
// ============================================================================

describe("scoreUser", () => {
  const base = {
    uid: "u1",
    username: "chefjane",
    firstName: "Jane",
    lastName: "Doe",
    avatarUrl: null,
  };

  it("scores a username match and reports follow state", () => {
    const result = scoreUser(
      base,
      "chefjane",
      "me",
      new Set(["u1"]),
      new Set(["u1"]),
      false
    );
    expect(result.isFollowing).toBe(true);
    expect(result.isMutual).toBe(true);
    // exact username (100) + mutual boost (40) on the USERS tab
    expect(result.score).toBe(140);
  });

  it("applies weaker social boosts on the ALL tab, gated by base relevance", () => {
    const result = scoreUser(
      base,
      "chefjane",
      "me",
      new Set(["u1"]),
      new Set(),
      true
    );
    // exact username (100) + following boost (15) on ALL tab
    expect(result.score).toBe(115);
  });

  it("gives no score to a non-match", () => {
    const result = scoreUser(
      base,
      "zzzz",
      "me",
      new Set(),
      new Set(),
      false
    );
    expect(result.score).toBe(0);
  });
});

describe("scoreRecipe", () => {
  const recipe = {
    id: "r1",
    title: "Spaghetti Carbonara",
    description: null,
    imageUrl: null,
    imageUrls: [],
    prepTime: 10,
    cookTime: 20,
    servings: 4,
    tags: ["italian"],
    creatorId: "c1",
    creator: { uid: "c1", username: "c", firstName: "C", lastName: "K" },
    ingredients: [{ type: "item", text: "spaghetti" }],
    updatedAt: new Date("2000-01-01"),
  };

  it("scores a title match and adds a saved-recipe boost on the RECIPES tab", () => {
    const result = scoreRecipe(
      recipe,
      "spaghetti carbonara",
      "me",
      new Set(),
      new Set(["r1"]),
      false
    );
    // exact title (100) + saved boost (15); recency 0 (old date)
    expect(result.score).toBe(115);
    expect(result.imageUrls).toEqual([]);
  });

  it("matches tags and ingredients", () => {
    const tagOnly = scoreRecipe(
      recipe,
      "italian",
      "me",
      new Set(),
      new Set(),
      false
    );
    expect(tagOnly.score).toBeGreaterThan(0);

    const ingredientOnly = scoreRecipe(
      recipe,
      "spaghetti",
      "me",
      new Set(),
      new Set(),
      false
    );
    // "spaghetti" also startsWith the title, so this simply must score
    expect(ingredientOnly.score).toBeGreaterThan(0);
  });
});

describe("scoreDishList", () => {
  const dishList = {
    id: "d1",
    title: "Weeknight Dinners",
    visibility: "PUBLIC",
    ownerId: "o1",
    owner: { uid: "o1", username: "owner", firstName: "O", lastName: "W" },
    collaborators: [],
    recipes: [],
    _count: { recipes: 3, followers: 9 },
    updatedAt: new Date("2000-01-01"),
  };

  it("scores a title match with a follow + popularity boost on the DISHLISTS tab", () => {
    const result = scoreDishList(
      dishList,
      "weeknight dinners",
      "me",
      new Set(),
      new Set(["d1"]),
      false
    );
    // exact title (100) + following (20) + popularity(9 -> ~3); recency 0
    expect(result.isFollowing).toBe(true);
    expect(result.score).toBeCloseTo(123, 5);
    expect(result.recipeCount).toBe(3);
    expect(result.followerCount).toBe(9);
  });

  it("reports collaborator membership", () => {
    const withCollab = {
      ...dishList,
      collaborators: [{ userId: "me", user: { firstName: "M", lastName: "E" } }],
    };
    const result = scoreDishList(
      withCollab,
      "weeknight",
      "me",
      new Set(),
      new Set(),
      false
    );
    expect(result.isCollaborator).toBe(true);
  });
});
