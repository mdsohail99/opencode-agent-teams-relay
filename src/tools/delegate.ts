import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { globalTracker, type TeamMember } from "../state/tracker.js"
import { WorktreeManager, type WorktreeSandbox } from "../worktree/manager.js"
import crypto from "node:crypto"

export const DelegateInput = Schema.Struct({
  team_name: Schema.String.annotate({
    description: "Departmental team name (e.g. 'Backend', 'Frontend', 'Security', 'QA', 'DevOps')",
  }),
  agent_type: Schema.String.annotate({
    description: "Specialist agent name or role (e.g. 'backend-architect', 'frontend-developer', 'api-tester')",
  }),
  prompt: Schema.String.annotate({
    description: "Detailed instructions and requirements for the teammate",
  }),
  worktree: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to run this task in an isolated git worktree to prevent concurrent write collisions (default: true)",
  }),
})

function normalizeAgentId(raw: string): string {
  if (!raw) return "build"
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export function createDelegateTool(ctx: Plugin.Context) {
  return {
    id: "team_delegate",
    name: "team_delegate",
    description: "Delegate a task to a departmental teammate with optional git worktree sandboxing.",
    input: DelegateInput,
    execute: async (
      input: { team_name: string; agent_type: string; prompt: string; worktree?: boolean },
      toolCtx: { sessionID: string },
    ) => {
      const taskId = crypto.randomUUID().slice(0, 8)
      const baseDir = process.cwd()
      const useWorktree = input.worktree !== false
      const targetAgentId = normalizeAgentId(input.agent_type)

      let sandbox: WorktreeSandbox | undefined
      let workDir = baseDir

      if (useWorktree) {
        try {
          sandbox = await WorktreeManager.createSandbox(baseDir, input.team_name, taskId)
          workDir = sandbox.worktreePath
        } catch (err: any) {
          // If worktree creation fails (e.g. not a git repo), gracefully fallback to baseDir
          workDir = baseDir
        }
      }

      // Create child session via OpenCode v2 session API
      let childSession: any
      try {
        childSession = await ctx.session.create({
          agent: targetAgentId,
          parentID: toolCtx.sessionID,
          location: { directory: workDir },
        } as any)
      } catch (err: any) {
        if (sandbox) {
          await WorktreeManager.discardSandbox(baseDir, sandbox)
        }
        return {
          content: `Failed to spawn teammate session for ${input.team_name} (${targetAgentId}): ${err.message || String(err)}`,
        }
      }

      const sessionId = childSession?.id || `sess_${taskId}`
      const memberRecord: TeamMember = {
        id: taskId,
        teamName: input.team_name,
        agentType: targetAgentId,
        sessionId,
        parentSessionId: toolCtx.sessionID,
        status: "running",
        prompt: input.prompt,
        worktreePath: sandbox?.worktreePath,
        worktreeBranch: sandbox?.branchName,
        createdAt: Date.now(),
      }
      globalTracker.register(memberRecord)

      try {
        // Dispatch task text to subagent (OpenCode v2 SessionPromptInput takes 'text')
        const promptResult = await ctx.session.prompt({
          sessionID: sessionId,
          text: input.prompt,
        } as any)

        if ((ctx.session as any)?.wait) {
          try {
            await (ctx.session as any).wait({ sessionID: sessionId })
          } catch {
            // Non-fatal if wait is unsupported or timed out
          }
        }

        let deliverableText =
          (promptResult as any)?.text ||
          (promptResult as any)?.content ||
          "Task execution dispatched."

        // If a worktree was used, reconcile and merge changes back to base branch
        let reconcileNotice = ""
        if (sandbox) {
          const shortDesc = input.prompt.replace(/\s+/g, " ").slice(0, 60)
          const reconcile = await WorktreeManager.reconcileAndCleanup(
            baseDir,
            sandbox,
            `feat(${input.team_name.toLowerCase()}): ${shortDesc}`,
          )

          if (reconcile.merged) {
            reconcileNotice = `\n[Git]: Successfully merged changes from ${sandbox.branchName} into ${sandbox.baseBranch}. Worktree cleaned up.`
          } else if (reconcile.error) {
            reconcileNotice = `\n[Git Warning]: ${reconcile.error}`
          } else {
            reconcileNotice = `\n[Git]: No file modifications detected; worktree discarded.`
          }
        }

        globalTracker.update(sessionId, {
          status: "completed",
          finishedAt: Date.now(),
          deliverable: deliverableText,
        })

        return {
          content: `[Teammate Completed] ${input.team_name} (${targetAgentId}):\n${deliverableText}${reconcileNotice}`,
        }
      } catch (err: any) {
        if (sandbox) {
          await WorktreeManager.discardSandbox(baseDir, sandbox)
        }
        globalTracker.update(sessionId, {
          status: "error",
          finishedAt: Date.now(),
          error: err?.message || String(err),
        })
        return {
          content: `[Teammate Error] ${input.team_name} (${targetAgentId}) failed: ${err.message || String(err)}`,
        }
      }
    },
  }
}
