# OpenCode v2 Migration & Handover: Native Agent-Teams to Plugin Architecture

> **Target Workspace:** `C:\Dev\opencode\orchestration` (`opencode-agent-teams-relay`)  
> **Source Core Fork:** `C:\Dev\opencode\core` (`feat/native-agent-teams` @ `1.19.3-ocd`)  
> **Target Upstream Version:** OpenCode v2 (`dev` branch, `@opencode/cli` >= 2.1.1)  
> **Date:** October 2026

---

## 1. Executive Summary & Objective

In OpenCode v1 (`v1.x`), the stock plugin API was limited. It could not register custom native tools, hook into session execution loops, or manage git worktree lifecycles. To achieve native, high-performance Agent-Teams, we built native modifications directly into a core fork (`packages/opencode/src/tool/task-teams.ts` and `src/worktree/`).

In OpenCode v2 (`origin/dev`, `@opencode/cli` 2.1.1):
1. Upstream underwent an architectural overhaul: `packages/opencode` was removed, replaced with modular packages (`@opencode/core`, `@opencode/server`, `@opencode/schema`, `@opencode/plugin`, `@opencode/cli`).
2. Upstream introduced a **first-class Plugin SDK** (`@opencode/plugin`) with full access to `context.tool`, `context.agent`, `context.worktree`, and `context.session`.
3. Upstream introduced native **Worktree services** (`packages/core/src/worktree/git.ts`).

### The Objective:
Migrate all custom functionality from the core fork (`C:\Dev\opencode\core`) into the orchestration package (`C:\Dev\opencode\orchestration\plugins\agent-teams.ts`). This transforms Agent-Teams from a fragile binary fork into a clean, installable OpenCode v2 plugin that runs on official upstream OpenCode (`opencode`) without maintaining a custom binary fork.

---

## 2. Core Fork Feature Inventory (What We Built in `core`)

The incoming orchestration agent needs to port three distinct systems from `core`:

### A. Team Protocol & Lifecycle (`packages/opencode/src/tool/task-teams.ts`)
The core fork exposed 4 native tools to the LLM:
1. `team_delegate`: Spawns or resumes a teammate session.
   - Parameters: `team_name`, `agent_type`, `prompt`, `worktree` (boolean), `env`.
   - Returns: `task_id`, `status` ("running" | "completed"), and initial output.
2. `team_status`: Queries current progress of all active teammates in the session.
   - Returns array of `{ task_id, team_name, agent_type, status, last_event, worktree_path }`.
3. `team_broadcast`: Sends a message or steer input to all running teammates simultaneously.
4. `team_terminate`: Gracefully terminates a running teammate and triggers worktree cleanup/reconciliation.

### B. Isolated Worktree Engine (`packages/opencode/src/worktree/index.ts`)
In the core fork, teammates run in their own git worktrees to prevent concurrent write collisions:
- Generates branch name: `agent/<team-name>-<task-id>`.
- Spawns worktree: `git worktree add -b agent/<team-name>-<task-id> <dir> HEAD`.
- Sets working directory of the subagent session to `<dir>`.
- Upon task completion: checks for uncommitted changes, formats commit, and cleans up worktree via `git worktree remove --force <dir>`.

### C. Prompt Injection & Team Roles (`packages/opencode/src/session/system.ts`)
- Injects departmental coordination rules (`AGENTS.md`) into the main router prompt.
- Restricts specialist tool access so leads only spawn allowed teammates.

---

## 3. OpenCode v2 Plugin Architecture (`@opencode/plugin`)

In OpenCode v2, plugins export a `define` contract that receives a unified `Context`:

```ts
import { define, type Context } from "@opencode/plugin"

export default define({
  id: "agent-teams",
  setup(ctx: Context) {
    // 1. Register Tools
    ctx.tool.add({
      id: "team_delegate",
      description: "Delegate a task to a departmental teammate",
      parameters: ...,
      execute: async (input, meta) => { ... }
    })

    // 2. Register/Update Agents
    ctx.agent.update("Agent-Teams", (agent) => {
      agent.instructions += "\n" + TEAM_ORCHESTRATION_PROMPT
    })

    // 3. Leverage Native Worktrees
    // ctx.worktree provides project worktree management directly

    // 4. Session & Tool Hooks
    ctx.tool.hook("execute.before", async (event) => { ... })
    ctx.tool.hook("execute.after", async (event) => { ... })
  }
})
```

### Key Differences Between v1 Relay and v2 Plugin:
| Concern | v1 Orchestration Relay (`plugins/agent-teams.ts`) | v2 Native Plugin (`@opencode/plugin`) |
| :--- | :--- | :--- |
| **Tool Registration** | Global `tool()` helper from `@opencode-ai/plugin` | `ctx.tool.add()` with strong schema typing |
| **Communication** | Spawns external Node process on localhost port 25800 (`agent-teams-relay.mjs`) | In-process execution via `ctx.session` and `ctx.event` |
| **Worktree** | External shell scripts / git CLI invocations | Direct integration with v2 `ctx.worktree` or native Git service |
| **Agent Injection** | String-matching regex on config files | `ctx.agent.update(id, callback)` |

---

## 4. Step-by-Step Porting Guide for the Orchestration Agent

### Step 1: Update Dependencies
In `C:\Dev\opencode\orchestration\package.json`:
- Replace legacy `@opencode-ai/plugin` (v1) with `@opencode/plugin` (v2).
- Update `@opencode/schema` and `@opencode/client`.

### Step 2: Eliminate the Port 25800 External Relay
- OpenCode v1 required `agent-teams-relay.mjs` and an auxiliary HTTP server because plugins could not listen to session events or maintain durable state in-process.
- In OpenCode v2, plugins execute directly within the OpenCode server lifecycle.
- **Action:** Transition teammate state tracking from the HTTP relay into an in-memory / storage-backed manager (`ctx.storage`) inside `agent-teams.ts`.

### Step 3: Implement the 4 Team Tools via `ctx.tool.add`
Port the logic from `packages/opencode/src/tool/task-teams.ts` in the core repo into `orchestration/plugins/agent-teams.ts`:
- Define schema using Effect `Schema` or TypeBox/Zod as accepted by `@opencode/schema/tool`.
- Connect `team_delegate` to v2's `ctx.session.create` / `ctx.session.prompt`.

### Step 4: Hook into Native Worktree Creation
In OpenCode v2:
- Inspect `packages/core/src/worktree/git.ts` in upstream `dev`.
- Utilize `ctx.worktree` or spawn lightweight git worktrees per teammate session, configuring the subagent session's root location to the worktree directory.

### Step 5: Test and Validate
1. Run `bun test` in `orchestration/test/`.
2. Configure a local `opencode.json`:
   ```json
   {
     "plugin": [
       "C:/Dev/opencode/orchestration"
     ]
   }
   ```
3. Launch official OpenCode v2 (`opencode`) and verify `team_delegate`, `team_status`, and isolated worktree execution.

---

## 5. Reference File Locations in Core Fork

When implementing, refer to these exact implementations in `C:\Dev\opencode\core`:
- **Team Tool Implementation:** [`packages/opencode/src/tool/task-teams.ts`](file:///C:/Dev/opencode/core/packages/opencode/src/tool/task-teams.ts)
- **Worktree Isolation Logic:** [`packages/opencode/src/worktree/index.ts`](file:///C:/Dev/opencode/core/packages/opencode/src/worktree/index.ts)
- **Worktree Environment Mapping:** [`packages/opencode/src/worktree/env.ts`](file:///C:/Dev/opencode/core/packages/opencode/src/worktree/env.ts)
- **Unit Tests for Worktrees:** [`packages/opencode/test/tool/task.worktree.test.ts`](file:///C:/Dev/opencode/core/packages/opencode/test/tool/task.worktree.test.ts)
- **Unit Tests for Teams:** [`packages/opencode/test/tool/task-teams.test.ts`](file:///C:/Dev/opencode/core/packages/opencode/test/tool/task-teams.test.ts)

---

## 6. Current Operational State

- **Current Daily Driver:** `1.19.3-ocd` is currently compiled, tested (all 116 unit tests passing), and globally installed as `ocd` and `opencode`.
- **Permission Fix:** Upstream permission prompt loop was solved via commit `cab584f039` in `feat/native-agent-teams`.
- **Status:** You can build and test the v2 plugin safely in `orchestration` without disrupting current daily development on `1.19.3-ocd`.
