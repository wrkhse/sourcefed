export type MonitorCreateInput = {
  issueKey?: string
  repo?: string
  prNumber?: number
  channelId?: string
  threadTs?: string
  threadUrl?: string
  url?: string
  space?: string
  match?: string
  exclude?: string
  labels?: string[]
  assignee?: string
  author?: string
  query?: string
  includeExisting?: boolean
  jql?: string
  cron?: string
  job?: string
  in?: string
  at?: string
  every?: string
  timezone?: string
}
