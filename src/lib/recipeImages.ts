import path from "path";
import { supabaseAdmin } from "./supabase";

const RECIPE_PUBLIC_PATH = "/storage/v1/object/public/recipes/";

function getRecipeObjectPath(url: string) {
  const parsed = new URL(url);
  const markerIndex = parsed.pathname.indexOf(RECIPE_PUBLIC_PATH);
  if (markerIndex === -1) {
    throw new Error("Recipe image is not stored in the recipes bucket");
  }

  return decodeURIComponent(
    parsed.pathname.slice(markerIndex + RECIPE_PUBLIC_PATH.length)
  );
}

export async function copyRecipeImagesForFork(
  sourceRecipeId: string,
  userId: string,
  imageUrls: string[]
) {
  const copiedUrls: string[] = [];

  for (const [index, imageUrl] of imageUrls.entries()) {
    const sourcePath = getRecipeObjectPath(imageUrl);
    const extension = path.extname(sourcePath) || ".jpg";
    const destinationPath = `${userId}/forks/${sourceRecipeId}/${index}${extension}`;

    const { data: source, error: downloadError } = await supabaseAdmin.storage
      .from("recipes")
      .download(sourcePath);

    if (downloadError || !source) {
      throw new Error("Failed to copy a recipe image");
    }

    const bytes = Buffer.from(await source.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from("recipes")
      .upload(destinationPath, bytes, {
        contentType: source.type || "image/jpeg",
        upsert: true,
      });

    if (uploadError) {
      throw new Error("Failed to save a copied recipe image");
    }

    const { data } = supabaseAdmin.storage
      .from("recipes")
      .getPublicUrl(destinationPath);
    copiedUrls.push(data.publicUrl);
  }

  return copiedUrls;
}
