import { PollSourceError } from "@sourcefed/core";
import { HttpError, type Http } from "@sourcefed/sdk";
import { jiraAuth } from "./jira-auth.ts";

/**
 * One read of the Jira REST v3 API. The base URL is read per request, so a host can point
 * one poll at another base; the three failures `HttpError` names keep the messages this
 * provider's users already see.
 */
export async function jiraFetch(http: Http, path: string): Promise<any> {
  const base = process.env.SOURCEFED_JIRA_BASE_URL;
  if (!base)
    throw new PollSourceError(
      "SOURCEFED_JIRA_BASE_URL is required for Jira monitors",
    );

  try {
    return await http.json(`${base}/rest/api/3${path}`, {
      headers: { Authorization: jiraAuth(), Accept: "application/json" },
    });
  } catch (error) {
    if (error instanceof HttpError && error.failure === "status") {
      throw new PollSourceError(`Jira ${error.status} for ${path}`);
    }
    if (error instanceof HttpError && error.failure === "body") {
      throw new PollSourceError(`Jira ${path} gave a body that is not JSON`, {
        cause: error,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new PollSourceError(`Jira ${path} request failed: ${message}`, {
      cause: error,
    });
  }
}
