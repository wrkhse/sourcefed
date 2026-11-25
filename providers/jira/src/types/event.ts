import type { EventSubject } from "@sourcefed/core";

export interface JiraEvent {
  kind: "comment" | "description" | "changelog";
  id?: string;
  issueKey: string;
  at: string;
  summary: string;
  body?: string;
  author?: string;
  actionable: boolean;
  terminal?: boolean;
  subject?: EventSubject;
}
