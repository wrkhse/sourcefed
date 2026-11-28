--!strict

-- The Event and BeforeVerdict shapes are declared in types/sourcefed.d.luau.
local plugin = {
	subscribes = { "github-issues" },
}

local BOT_AUTHORS = {
	["github-actions[bot]"] = true,
	["dependabot[bot]"] = true,
	["sourcefed[bot]"] = true,
	bot = true,
}

function plugin.eventBefore(event: Event): BeforeVerdict
	local author = event.author

	if author ~= nil and BOT_AUTHORS[author] == true then
		return {
			kind = "drop",
			reason = "bot author",
		}
	end

	return { kind = "keep" }
end

return plugin
