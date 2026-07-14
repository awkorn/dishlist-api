import { describe, expect, it } from "vitest";
import { mapScrapeCreatorsResponse } from "../socialImport/scrapeCreatorsFetcher";

// Fixtures mirror the documented ScrapeCreators response shapes. If the vendor
// drifts, these tests pin what our mapper expects so the fix is localized.

const tiktokFixture = {
  aweme_detail: {
    aweme_id: "7186537191194365227",
    desc: "Easy 10 minute garlic noodles! #recipe #noodles",
    share_url:
      "https://www.tiktok.com/@cookinglynja/video/7186537191194365227?utm_source=x",
    author: { unique_id: "cookinglynja", nickname: "Lynja" },
    video: {
      duration: 89793,
      cover: { url_list: ["https://cdn.tiktok.com/cover1.jpg"] },
      dynamic_cover: { url_list: ["https://cdn.tiktok.com/dyn.jpg"] },
      play_addr: { url_list: ["https://cdn.tiktok.com/play.mp4"] },
      download_addr: { url_list: ["https://cdn.tiktok.com/dl.mp4"] },
    },
  },
};

const instagramFixture = {
  data: {
    xdt_shortcode_media: {
      shortcode: "C0abc123",
      edge_media_to_caption: {
        edges: [{ node: { text: "Full recipe: 2 cups flour, 1 egg..." } }],
      },
      owner: { username: "halfbakedharvest" },
      thumbnail_src: "https://cdn.instagram.com/thumb.jpg",
      display_url: "https://cdn.instagram.com/display.jpg",
      video_url: "https://cdn.instagram.com/video.mp4",
      video_duration: 71.1,
    },
  },
};

const facebookFixture = {
  url: "https://www.facebook.com/reel/1535656380759655",
  description: "Grandma's lasagna recipe ❤️",
  author: { name: "Cooking With Nonna" },
  video: {
    thumbnail: "https://cdn.fb.com/thumb.jpg",
    sd_url: "https://cdn.fb.com/sd.mp4",
    hd_url: "https://cdn.fb.com/hd.mp4",
    length_in_second: 23.36,
  },
};

describe("mapScrapeCreatorsResponse — TikTok", () => {
  it("maps the documented aweme_detail shape", () => {
    const post = mapScrapeCreatorsResponse(
      "TIKTOK",
      tiktokFixture,
      "https://vm.tiktok.com/ZM6/"
    );
    expect(post).toEqual({
      platform: "TIKTOK",
      resolvedUrl: "https://tiktok.com/@cookinglynja/video/7186537191194365227",
      caption: "Easy 10 minute garlic noodles! #recipe #noodles",
      authorHandle: "@cookinglynja",
      thumbnailUrl: "https://cdn.tiktok.com/cover1.jpg",
      videoUrl: "https://cdn.tiktok.com/play.mp4",
      durationSec: 90,
    });
  });

  it("falls back to download_addr when play_addr is missing", () => {
    const fixture = structuredClone(tiktokFixture);
    delete (fixture.aweme_detail.video as any).play_addr;
    const post = mapScrapeCreatorsResponse("TIKTOK", fixture, "x://y");
    expect(post.videoUrl).toBe("https://cdn.tiktok.com/dl.mp4");
  });

  it("degrades to nulls on an empty payload", () => {
    const post = mapScrapeCreatorsResponse(
      "TIKTOK",
      {},
      "https://vm.tiktok.com/ZM6/"
    );
    expect(post.caption).toBeNull();
    expect(post.videoUrl).toBeNull();
    expect(post.durationSec).toBeNull();
    expect(post.resolvedUrl).toBe("https://vm.tiktok.com/ZM6/");
  });
});

describe("mapScrapeCreatorsResponse — Instagram", () => {
  it("maps the documented xdt_shortcode_media shape", () => {
    const post = mapScrapeCreatorsResponse(
      "INSTAGRAM",
      instagramFixture,
      "https://www.instagram.com/reel/C0abc123/?igsh=1"
    );
    expect(post).toEqual({
      platform: "INSTAGRAM",
      resolvedUrl: "https://instagram.com/p/C0abc123",
      caption: "Full recipe: 2 cups flour, 1 egg...",
      authorHandle: "@halfbakedharvest",
      thumbnailUrl: "https://cdn.instagram.com/thumb.jpg",
      videoUrl: "https://cdn.instagram.com/video.mp4",
      durationSec: 71,
    });
  });

  it("falls back to display_url when thumbnail_src is missing", () => {
    const fixture = structuredClone(instagramFixture);
    delete (fixture.data.xdt_shortcode_media as any).thumbnail_src;
    const post = mapScrapeCreatorsResponse("INSTAGRAM", fixture, "x://y");
    expect(post.thumbnailUrl).toBe("https://cdn.instagram.com/display.jpg");
  });
});

describe("mapScrapeCreatorsResponse — Facebook", () => {
  it("maps the documented post shape, preferring HD video", () => {
    const post = mapScrapeCreatorsResponse(
      "FACEBOOK",
      facebookFixture,
      "https://fb.watch/xyz/"
    );
    expect(post).toEqual({
      platform: "FACEBOOK",
      resolvedUrl: "https://www.facebook.com/reel/1535656380759655",
      caption: "Grandma's lasagna recipe ❤️",
      authorHandle: "Cooking With Nonna",
      thumbnailUrl: "https://cdn.fb.com/thumb.jpg",
      videoUrl: "https://cdn.fb.com/hd.mp4",
      durationSec: 23,
    });
  });

  it("falls back to sd_url when hd_url is missing", () => {
    const fixture = structuredClone(facebookFixture);
    delete (fixture.video as any).hd_url;
    const post = mapScrapeCreatorsResponse("FACEBOOK", fixture, "x://y");
    expect(post.videoUrl).toBe("https://cdn.fb.com/sd.mp4");
  });
});
