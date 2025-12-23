export type RecipeItemType = 'item' | 'header';

export interface RecipeItem {
  type: RecipeItemType;
  text: string;
}

// Validation helper
export function validateRecipeItems(items: any[], fieldName: string): string | null {
  if (!Array.isArray(items)) {
    return `${fieldName} must be an array`;
  }
  
  // Check for at least one actual item
  const hasItem = items.some(
    (item) => item && item.type === 'item' && item.text?.trim()
  );
  
  if (!hasItem) {
    return `At least one ${fieldName.slice(0, -1)} is required`;
  }
  
  // Validate structure of each item
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      return `Invalid ${fieldName.slice(0, -1)} format`;
    }
    if (item.type !== 'item' && item.type !== 'header') {
      return `Invalid ${fieldName.slice(0, -1)} type`;
    }
    if (typeof item.text !== 'string') {
      return `${fieldName} text must be a string`;
    }
  }
  
  return null;
}

// Clean items before saving
export function cleanRecipeItems(items: RecipeItem[]): RecipeItem[] {
  const cleaned: RecipeItem[] = [];
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    
    if (item.type === 'item' && item.text.trim()) {
      cleaned.push({ type: 'item', text: item.text.trim() });
    } else if (item.type === 'header') {
      // Check if header has items below it
      let hasItemsBelow = false;
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].type === 'header') break;
        if (items[j].type === 'item' && items[j].text.trim()) {
          hasItemsBelow = true;
          break;
        }
      }
      if (hasItemsBelow && item.text.trim()) {
        cleaned.push({ type: 'header', text: item.text.trim() });
      }
    }
  }
  
  return cleaned;
}