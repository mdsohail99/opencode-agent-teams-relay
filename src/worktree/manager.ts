import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import fs from "node:fs/promises"

const exec = promisify(execFile)

export interface WorktreeSandbox {
  worktreePath: string
  branchName: string
  baseBranch: string
}

export interface ReconcileResult {
  success: boolean
  merged: boolean
  commitHash?: string
  error?: string
}

export class WorktreeManager {
  static async getCurrentBranch(cwd: string): Promise<string> {
    try {
      const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
      return stdout.trim() || "main"
    } catch {
      return "main"
    }
  }

  static async createSandbox(
    baseDir: string,
    teamName: string,
    taskId: string,
  ): Promise<WorktreeSandbox> {
    const baseBranch = await this.getCurrentBranch(baseDir)
    const sanitizedTeam = teamName.toLowerCase().replace(/[^a-z0-9]/g, "-")
    const shortId = taskId.replace(/[^a-z0-9]/gi, "").slice(-6)
    const branchName = `agent/${sanitizedTeam}-${shortId}`

    const worktreeDir = path.join(baseDir, ".opencode", "worktrees", `${sanitizedTeam}-${shortId}`)
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true })

    // Clean up any stale worktree or branch with identical name
    try {
      await exec("git", ["worktree", "remove", "--force", worktreeDir], { cwd: baseDir })
    } catch {}
    try {
      await exec("git", ["branch", "-D", branchName], { cwd: baseDir })
    } catch {}

    // Create the worktree on a new branch branched off HEAD
    await exec("git", ["worktree", "add", "-b", branchName, worktreeDir, "HEAD"], { cwd: baseDir })

    return {
      worktreePath: worktreeDir,
      branchName,
      baseBranch,
    }
  }

  static async reconcileAndCleanup(
    baseDir: string,
    sandbox: WorktreeSandbox,
    commitMessage: string,
  ): Promise<ReconcileResult> {
    const { worktreePath, branchName, baseBranch } = sandbox

    try {
      // 1. Check for modifications inside the worktree
      const { stdout: status } = await exec("git", ["status", "--porcelain"], {
        cwd: worktreePath,
      })

      let committed = false
      if (status.trim().length > 0) {
        await exec("git", ["add", "-A"], { cwd: worktreePath })
        await exec("git", ["commit", "-m", commitMessage], { cwd: worktreePath })
        committed = true
      }

      // 2. If nothing changed, just remove the worktree and branch
      if (!committed) {
        await this.discardSandbox(baseDir, sandbox)
        return { success: true, merged: false }
      }

      // 3. Obtain latest commit hash from the agent branch
      const { stdout: hashOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath })
      const commitHash = hashOut.trim()

      // 4. Merge back to the base branch in baseDir
      try {
        await exec(
          "git",
          ["merge", "--no-ff", "-m", `Merge ${branchName}: ${commitMessage}`, branchName],
          { cwd: baseDir },
        )
      } catch (mergeErr: any) {
        // Conflict detected — abort merge in base repo and preserve branch for review
        try {
          await exec("git", ["merge", "--abort"], { cwd: baseDir })
        } catch {}
        return {
          success: false,
          merged: false,
          commitHash,
          error: `Merge conflict integrating ${branchName} into ${baseBranch}. Branch preserved for inspection.`,
        }
      }

      // 5. Successful merge — cleanup worktree and delete ephemeral branch
      await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: baseDir })
      try {
        await exec("git", ["branch", "-d", branchName], { cwd: baseDir })
      } catch {
        await exec("git", ["branch", "-D", branchName], { cwd: baseDir })
      }

      return {
        success: true,
        merged: true,
        commitHash,
      }
    } catch (err: any) {
      return {
        success: false,
        merged: false,
        error: err?.message || String(err),
      }
    }
  }

  static async discardSandbox(baseDir: string, sandbox: WorktreeSandbox): Promise<void> {
    try {
      await exec("git", ["worktree", "remove", "--force", sandbox.worktreePath], { cwd: baseDir })
    } catch {}
    try {
      await exec("git", ["branch", "-D", sandbox.branchName], { cwd: baseDir })
    } catch {}
  }
}
