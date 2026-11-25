import { PollSourceError } from "@sourcefed/core";
import type { GithubClient } from "./client.ts";

const MAX_COMMENT_PAGES = 10;

export async function fetchGithubComments(
  github: GithubClient,
  path: string,
): Promise<any[]> {
  const comments: any[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const batch = await github.json(`/${path}?per_page=100&page=${page}`);
    if (!Array.isArray(batch))
      throw new PollSourceError(
        `GitHub gave an unexpected comments list for ${path}`,
      );

    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  return comments;
}
