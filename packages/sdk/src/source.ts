import { Monitor, PollMonitor } from "@sourcefed/core"
import type { MonitorCreateInput, MonitorSource, SourceInput, SourceInputSchema, SourcePollResult } from "@sourcefed/core"
import type { GenericSchema } from "valibot"
import { fetchHttp, type Http } from "./http.ts"

/** What one poll is given. Cancellation and log lines arrive with the worker boundary, not this slice. */
export type SourceContext<T extends MonitorSource> = {
  readonly source: T
  readonly cursor: unknown
  readonly monitorId: string
  readonly http: Http
}

/** Everything a source is: its type and schema, its create input, its display, and its poll. */
export type SourceDefinition<T extends MonitorSource> = {
  readonly type: T["type"]
  readonly schema: GenericSchema<T>
  readonly input: SourceInputSchema
  readonly build: (input: MonitorCreateInput) => SourceInput
  readonly key: (source: T) => string
  readonly label: (source: T) => string
  readonly detail: (source: T) => string
  readonly describe: (source: T) => string
  readonly icon?: string
  readonly poll: (context: SourceContext<T>) => Promise<SourcePollResult>
}

/** What the host gives a source. A test or the golden harness supplies its own http. */
export type SourceHost = { readonly http: Http }

/**
 * Turns one definition into the core Monitor the daemon already knows, so a source is data
 * plus a poll function and the runtime above it is untouched.
 */
export function defineSource<T extends MonitorSource>(definition: SourceDefinition<T>, host: SourceHost = { http: fetchHttp() }): Monitor<T> {
  return new PluginMonitor(definition, host)
}

/** The Monitor core sees; every read of the definition happens here, and nowhere else. */
class PluginMonitor<T extends MonitorSource> extends Monitor<T> {
  readonly key: (source: T) => string
  readonly label: (source: T) => string
  readonly detail: (source: T) => string
  readonly describe: (source: T) => string
  readonly icon: string
  readonly input: SourceInputSchema
  readonly poll: PollMonitor<T>

  constructor(private readonly definition: SourceDefinition<T>, host: SourceHost) {
    super({ type: definition.type, schema: definition.schema })

    this.key = definition.key
    this.label = definition.label
    this.detail = definition.detail
    this.describe = definition.describe
    this.icon = definition.icon ?? ""
    this.input = definition.input
    this.poll = new PollMonitor<T>({
      run: (source, cursor, monitorId) => definition.poll({ source, cursor, monitorId, http: host.http }),
    })
  }

  build(input: MonitorCreateInput): SourceInput {
    return this.definition.build(input)
  }
}
