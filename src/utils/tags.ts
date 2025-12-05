/**
 * Normalize a tag for consistent storage and searching
 */
export const normalizeTag = (tag: string): string => {
  return tag
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
};

/**
 * Normalize and validate an array of tags
 * - Removes empty tags
 * - Normalizes each tag
 * - Removes duplicates
 * - Enforces max 5 tags
 * - Enforces max 25 characters per tag
 */
export const normalizeTags = (tags: string[]): string[] => {
  const MAX_TAGS = 5;
  const MAX_TAG_LENGTH = 25;

  const normalized = tags
    .map(normalizeTag)
    .filter(tag => tag.length > 0 && tag.length <= MAX_TAG_LENGTH)
    .slice(0, MAX_TAGS);

  // Remove duplicates while preserving order
  return [...new Set(normalized)];
};

/**
 * Validate tags and return error message if invalid
 */
export const validateTags = (tags: unknown): string | null => {
  if (tags === undefined || tags === null) {
    return null; // Tags are optional
  }

  if (!Array.isArray(tags)) {
    return 'Tags must be an array';
  }

  if (tags.length > 5) {
    return 'Maximum 5 tags allowed';
  }

  for (const tag of tags) {
    if (typeof tag !== 'string') {
      return 'Each tag must be a string';
    }
    if (tag.trim().length > 25) {
      return 'Each tag must be 25 characters or less';
    }
  }

  return null;
};