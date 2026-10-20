export interface TeamMember {
  id: string
  teamName: string
  agentType: string
  sessionId: string
  parentSessionId: string
  status: "running" | "completed" | "error" | "terminated"
  prompt: string
  worktreePath?: string
  worktreeBranch?: string
  createdAt: number
  finishedAt?: number
  lastEvent?: string
  deliverable?: string
  error?: string
}

export class SwarmTracker {
  private members = new Map<string, TeamMember>()

  register(member: TeamMember): void {
    this.members.set(member.sessionId, member)
  }

  update(sessionId: string, patch: Partial<TeamMember>): TeamMember | undefined {
    const existing = this.members.get(sessionId)
    if (!existing) return undefined
    const updated = { ...existing, ...patch }
    this.members.set(sessionId, updated)
    return updated
  }

  get(idOrSessionId: string): TeamMember | undefined {
    if (this.members.has(idOrSessionId)) {
      return this.members.get(idOrSessionId)
    }
    for (const member of this.members.values()) {
      if (member.id === idOrSessionId || member.teamName.toLowerCase() === idOrSessionId.toLowerCase()) {
        return member
      }
    }
    return undefined
  }

  list(parentSessionId?: string): TeamMember[] {
    const all = Array.from(this.members.values())
    if (!parentSessionId) return all
    return all.filter((m) => m.parentSessionId === parentSessionId)
  }

  formatTree(parentSessionId?: string): string {
    const list = this.list(parentSessionId)
    if (list.length === 0) {
      return "No active or recorded teammates in this session."
    }

    const lines: string[] = ["Swarm Hierarchy & Teammate Status:"]
    const byTeam = new Map<string, TeamMember[]>()
    for (const m of list) {
      const items = byTeam.get(m.teamName) || []
      items.push(m)
      byTeam.set(m.teamName, items)
    }

    const teams = Array.from(byTeam.keys())
    teams.forEach((team, tIdx) => {
      const isLastTeam = tIdx === teams.length - 1
      const teamPrefix = isLastTeam ? "└── " : "├── "
      const subPrefix = isLastTeam ? "    " : "│   "
      lines.push(`${teamPrefix}[Team: ${team}]`)

      const members = byTeam.get(team)!
      members.forEach((m, mIdx) => {
        const isLastMember = mIdx === members.length - 1
        const memberBranch = isLastMember ? "└── " : "├── "
        const elapsed = m.finishedAt
          ? `${Math.round((m.finishedAt - m.createdAt) / 1000)}s`
          : `${Math.round((Date.now() - m.createdAt) / 1000)}s`
        const statusEmoji =
          m.status === "completed"
            ? "✅"
            : m.status === "running"
              ? "⚡"
              : m.status === "error"
                ? "❌"
                : "🛑"
        const wtInfo = m.worktreeBranch ? ` (worktree: ${m.worktreeBranch})` : ""
        lines.push(
          `${subPrefix}${memberBranch}${statusEmoji} ${m.agentType} [${m.status}] (${elapsed})${wtInfo}`,
        )
        if (m.deliverable) {
          const preview = m.deliverable.replace(/\s+/g, " ").trim().slice(0, 120)
          lines.push(`${subPrefix}${isLastMember ? "    " : "│   "}↳ deliverable: ${preview}...`)
        }
      })
    })

    return lines.join("\n")
  }
}

export const globalTracker = new SwarmTracker()
