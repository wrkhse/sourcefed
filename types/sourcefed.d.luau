--!strict

-- The event shape handed to an eventBefore hook. author is absent on events
-- written before the field existed.
type Event = {
	id: string,
	kind: string,
	subject: {
		source: string,
		key: string,
	},
	summary: string,
	at: string,
	author: string?,
}

-- A hook either keeps the event or drops it with a human-readable reason.
type BeforeVerdict = {
	kind: "keep",
} | {
	kind: "drop",
	reason: string,
}
