import { Plugin } from "@opencode/plugin"
import { createDelegateTool } from "./tools/delegate.js"
import { createStatusTool } from "./tools/status.js"
import { createBroadcastTool } from "./tools/broadcast.js"
import { createTerminateTool } from "./tools/terminate.js"
import { globalTracker } from "./state/tracker.js"
import fs from "node:fs"
import path from "node:path"

export const AGENT_TEAMS_ORCHESTRATION_RULES = `
<!-- agent-teams-orchestration:start -->
# Department Team-Lead Orchestration (Agent-Teams v2)

The swarm is organized into departments led by Orchestrators (Backend, Frontend, Security, DevOps, AI & Data, QA).

## Swarm Protocol:
1. Use \`team_delegate\` to dispatch tasks to specialists in dedicated, isolated git worktrees.
2. Monitor progress non-blockingly using \`team_status\`.
3. Broadcast steering guidance or updates using \`team_broadcast\`.
4. Gracefully terminate tasks using \`team_terminate\`.
5. Upon task completion, changes in the worktree are automatically committed and merged into the base branch.
6. OpenCode hierarchical depth = 2 (subagent_depth: 2) enables Department Leads (Depth 1) to dispatch Domain Specialists (Depth 2).
<!-- agent-teams-orchestration:end -->
`

/**
 * Ensures subagent_depth: 2 is present in an opencode.json configuration file.
 */
function ensureSubagentDepth(filePath: string) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (typeof parsed === "object" && parsed !== null) {
        if (!parsed.subagent_depth || parsed.subagent_depth < 2) {
          parsed.subagent_depth = 2
          fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8")
        }
      }
    }
  } catch {
    // Non-fatal safety guard
  }
}

export default Plugin.define({
  id: "agent-teams",
  async setup(ctx: Plugin.Context) {
    // 0. Auto-ensure subagent_depth: 2 in local and config-dir opencode.json
    ensureSubagentDepth(path.resolve(process.cwd(), "opencode.json"))
    if (process.env.OPENCODE_CONFIG_DIR) {
      ensureSubagentDepth(path.join(process.env.OPENCODE_CONFIG_DIR, "opencode.json"))
    }

    // 1. Register Swarm Tools (team_delegate, team_status, team_broadcast, team_terminate)
    ctx.tool.transform((editor: any) => {
      editor.add(createDelegateTool(ctx))
      editor.add(createStatusTool(ctx))
      editor.add(createBroadcastTool(ctx))
      editor.add(createTerminateTool(ctx))
    })

    // 2. Register Clean, Non-Conflicting Slash Commands
    if (ctx.command?.transform) {
      ctx.command.transform((editor: any) => {
        editor.add({
          name: "team",
          description: "Display live hierarchical swarm status tree and active worktrees",
          execute: async (inv: any) => {
            const tree = globalTracker.formatTree(inv.sessionID)
            await ctx.session.prompt({
              sessionID: inv.sessionID,
              text: `Please display the following active swarm status to the user:\n\`\`\`\n${tree}\n\`\`\``,
            } as any)
          },
        })

        editor.add({
          name: "team-status",
          description: "Inspect swarm progress and active teammate worktrees",
          execute: async (inv: any) => {
            const tree = globalTracker.formatTree(inv.sessionID)
            await ctx.session.prompt({
              sessionID: inv.sessionID,
              text: `Teammate status report:\n\`\`\`\n${tree}\n\`\`\``,
            } as any)
          },
        })

        editor.add({
          name: "team-stop",
          description: "Halt all running teammates in the swarm and clean up worktrees",
          execute: async (inv: any) => {
            const tool = createTerminateTool(ctx)
            const res = await tool.execute({ target: "all" }, { sessionID: inv.sessionID })
            await ctx.session.prompt({
              sessionID: inv.sessionID,
              text: `Swarm termination executed:\n${res.content}`,
            } as any)
          },
        })
      })
    }

    // 3. Inject Orchestration System Rules to Agent-Teams
    if (ctx.agent?.transform) {
      ctx.agent.transform((editor: any) => {
        const agentTeams = editor.get("Agent-Teams") || editor.get("agent-teams")
        if (agentTeams && agentTeams.instructions) {
          agentTeams.instructions += `\n\n${AGENT_TEAMS_ORCHESTRATION_RULES}`
        }
      })
    }
  },
})
