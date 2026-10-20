import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { globalTracker } from "../state/tracker.js"

export const BroadcastInput = Schema.Struct({
  message: Schema.String.annotate({
    description: "Guidance or steering message to broadcast to active teammates",
  }),
  team_name: Schema.optional(Schema.String).annotate({
    description: "Limit broadcast to a specific department, or omit to broadcast to all running teammates",
  }),
})

export function createBroadcastTool(ctx: Plugin.Context) {
  return {
    id: "team_broadcast",
    name: "team_broadcast",
    description: "Broadcast steering instructions to active teammates simultaneously.",
    input: BroadcastInput,
    execute: async (
      input: { message: string; team_name?: string },
      toolCtx: { sessionID: string },
    ) => {
      const allMembers = globalTracker.list(toolCtx.sessionID)
      const running = allMembers.filter((m) => {
        if (m.status !== "running") return false
        if (input.team_name && m.teamName.toLowerCase() !== input.team_name.toLowerCase()) {
          return false
        }
        return true
      })

      if (running.length === 0) {
        return {
          content: "No matching running teammates found to receive the broadcast.",
        }
      }

      const results = await Promise.allSettled(
        running.map(async (m) => {
          await ctx.session.prompt({
            sessionID: m.sessionId,
            prompt: `[Broadcast from Orchestrator]: ${input.message}`,
          } as any)
          return m.teamName
        }),
      )

      const notified = results
        .filter((r) => r.status === "fulfilled")
        .map((_, i) => running[i].teamName)

      return {
        content: `Broadcast delivered to ${notified.length} teammate(s): ${notified.join(", ")}`,
      }
    },
  }
}
