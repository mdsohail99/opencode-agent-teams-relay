import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { globalTracker } from "../state/tracker.js"
import { WorktreeManager } from "../worktree/manager.js"

export const TerminateInput = Schema.Struct({
  target: Schema.String.annotate({
    description: "Teammate ID, team name (e.g. 'Frontend'), or 'all' to terminate all running workers",
  }),
})

export function createTerminateTool(ctx: Plugin.Context) {
  return {
    id: "team_terminate",
    name: "team_terminate",
    description:
      "Gracefully abort/terminate a running teammate and trigger git worktree cleanup.",
    input: TerminateInput,
    execute: async (input: { target: string }, toolCtx: { sessionID: string }) => {
      const allMembers = globalTracker.list(toolCtx.sessionID)
      const isAll = input.target.toLowerCase() === "all"

      const targets = allMembers.filter((m) => {
        if (m.status !== "running") return false
        if (isAll) return true
        return (
          m.id === input.target ||
          m.sessionId === input.target ||
          m.teamName.toLowerCase() === input.target.toLowerCase()
        )
      })

      if (targets.length === 0) {
        return {
          content: `No active running teammates matched target '${input.target}'.`,
        }
      }

      const terminated: string[] = []
      const baseDir = process.cwd()

      for (const member of targets) {
        try {
          if (ctx.session.interrupt) {
            await ctx.session.interrupt({ sessionID: member.sessionId } as any)
          }
        } catch {}

        if (member.worktreePath && member.worktreeBranch) {
          await WorktreeManager.discardSandbox(baseDir, {
            worktreePath: member.worktreePath,
            branchName: member.worktreeBranch,
            baseBranch: "main",
          })
        }

        globalTracker.update(member.sessionId, {
          status: "terminated",
          finishedAt: Date.now(),
        })

        terminated.push(`${member.teamName} (${member.id})`)
      }

      return {
        content: `Terminated and cleaned up ${terminated.length} teammate(s): ${terminated.join(", ")}`,
      }
    },
  }
}
