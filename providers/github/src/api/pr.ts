import { PollSourceError } from "@sourcefed/core";
import type { GithubClient } from "./client.ts";

export type GithubPrData = {
  title?: string;
  reviews: any[];
  statusCheckRollup: any[];
  mergeable?: string;
  mergeStateStatus?: string;
  state?: string;
};

const PR_DATA_QUERY = `
query PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title
      state
      mergeable
      mergeStateStatus
      reviews(first: 100, after: $reviewsAfter) {
        nodes {
          databaseId
          author { login }
          state
          submittedAt
          body
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      statusCheckRollup {
        contexts(first: 100, after: $contextsAfter) {
          nodes {
            ... on StatusContext {
              context
              state
              targetUrl
            }
            ... on CheckRun {
              name
              conclusion
              detailsUrl
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
}`;

const MAX_REVIEW_PAGES = 300;
// 500 checks; a poll's requests stay bounded however many a pull request has.
const MAX_CONTEXT_PAGES = 5;

export async function fetchPrData(
  github: GithubClient,
  repo: string,
  prNumber: number,
): Promise<GithubPrData> {
  const [owner, name] = repo.split("/");
  if (!owner || !name)
    throw new PollSourceError(`GitHub repository ${repo} is not owner/name`);
  const data = await github.graphql(PR_DATA_QUERY, {
    owner,
    name,
    number: prNumber,
    reviewsAfter: undefined,
    contextsAfter: undefined,
  });
  const pullRequest = data?.repository?.pullRequest;
  if (!pullRequest)
    throw new PollSourceError(`GitHub has no pull request ${repo}#${prNumber}`);

  const reviews: any[] = [];
  let page = pullRequest.reviews;
  while (page?.nodes && page.nodes.length > 0) {
    reviews.push(
      ...page.nodes.map((node: any) => ({
        id: node.databaseId,
        author: node.author,
        state: node.state,
        submittedAt: node.submittedAt,
        body: node.body,
      })),
    );
    if (!page.pageInfo?.hasNextPage || reviews.length >= MAX_REVIEW_PAGES)
      break;
    const next = await github.graphql(PR_DATA_QUERY, {
      owner,
      name,
      number: prNumber,
      reviewsAfter: page.pageInfo.endCursor,
      contextsAfter: undefined,
    });
    page = next?.repository?.pullRequest?.reviews;
  }

  const statusCheckRollup: any[] = [];
  let contextsPage = pullRequest.statusCheckRollup?.contexts;
  for (
    let pages = 1;
    contextsPage?.nodes && contextsPage.nodes.length > 0;
    pages++
  ) {
    statusCheckRollup.push(...contextsPage.nodes);
    if (!contextsPage.pageInfo?.hasNextPage || pages >= MAX_CONTEXT_PAGES)
      break;
    const next = await github.graphql(PR_DATA_QUERY, {
      owner,
      name,
      number: prNumber,
      reviewsAfter: undefined,
      contextsAfter: contextsPage.pageInfo.endCursor,
    });
    contextsPage = next?.repository?.pullRequest?.statusCheckRollup?.contexts;
  }

  return {
    title: pullRequest.title,
    reviews,
    statusCheckRollup,
    mergeable: pullRequest.mergeable,
    mergeStateStatus: pullRequest.mergeStateStatus,
    state: pullRequest.state,
  };
}
