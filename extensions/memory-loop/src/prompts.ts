export function observerPrompt(messages: string, recentObservations: string): string {
  const dedupSection = recentObservations
    ? `\nALREADY CAPTURED (do NOT repeat these):\n${recentObservations}\n`
    : "";

  return `You are a memory extraction system for a personal AI assistant. Extract ONLY information worth remembering in future conversations.

SKIP: greetings, small talk, status checks, "how are you", session starts, tool errors, routine confirmations.
KEEP: facts about the user/projects, decisions made, tasks created or completed, preferences expressed, things built or configured, bugs found/fixed.

Categories (use exactly one per bullet):
- **Fact**: concrete info discovered or stated (names, numbers, configs, accounts, credentials setup)
- **Decision**: a choice or direction chosen
- **Task**: something to do later (prefix description with TODO:)
- **Preference**: how the user likes things done
- **Built**: something created, deployed, or configured
- **Fix**: a bug found and resolved
${dedupSection}
Rules:
- One bullet per observation, max 15 words per bullet
- Merge related points into one bullet
- Do NOT repeat anything from ALREADY CAPTURED
- Output ONLY bullets. No headers, no commentary
- If nothing new worth remembering: output nothing (empty response)

MESSAGES:
${messages}`;
}

export function reflectorPrompt(todayObservations: string, currentMemory: string): string {
  return `You are a memory consolidation system. Your job is to produce a COMPLETE, updated MEMORY.md file.

You will receive the current MEMORY.md and today's new observations. Output a complete replacement MEMORY.md that:
1. PRESERVES all existing sections and facts that are still accurate
2. INTEGRATES today's observations into the appropriate sections (or creates new sections)
3. UPDATES any facts that have changed (e.g., project status, system state)
4. REMOVES completed TODOs (mark as done or delete)
5. REMOVES stale/outdated information that's no longer relevant
6. Keeps the file UNDER 100 lines total

Section format — use these standard sections (skip empty ones):
## Owner — user identity, contact info
## System — infrastructure, machine, config state
## Projects — active projects with current status
## Preferences — how the user likes things done
## Skills — installed skills and tools
## Recent — last 7 days of notable events (rotate old ones out)

Rules:
- Output ONLY the markdown content of MEMORY.md. No code fences, no commentary.
- Start with \`# MEMORY.md\` header
- Keep bullets concise (max 15 words each)
- If a TODO from observations is done, remove it; if still pending, keep it
- The "Recent" section replaces the old auto-distilled sections — keep max 7 days

TODAY'S OBSERVATIONS:
${todayObservations}

CURRENT MEMORY.md:
${currentMemory}`;
}
