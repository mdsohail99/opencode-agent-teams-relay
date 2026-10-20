import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { globalTracker } from "../state/tracker.js"

export const StatusInput = Schema.Struct({
  team_name: Schema.optional(Schema.String).annotate({
    description: "Filter status query to a specific department (optional)",
  }),
})

export function createStatusTool(ctx: Plugin.Context) {
  return {
    id: "team_status",
    name: "team_status",
    description:
      "Inspect current progress, deliverables, active git worktrees, and hierarchy of all teammates in the swarm.",
    input: StatusInput,
    execute: async (input: { team_name?: string }, toolCtx: { sessionID: string }) => {
      const tree = globalTracker.formatTree(toolCtx.sessionID)
      return {
        content: tree,
      }
    },
  }
}
