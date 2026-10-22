import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { globalTracker } from "../src/state/tracker.js"
import { WorktreeManager } from "../src/worktree/manager.js"
import { createStatusTool } from "../src/tools/status.js"
import { createBroadcastTool } from "../src/tools/broadcast.js"
import { createTerminateTool } from "../src/tools/terminate.js"

const exec = promisify(execFile)

async function runTests() {
  console.log("==================================================")
  console.log(" Running Agent-Teams v2 Test Suite")
  console.log("==================================================")

  const parentSession = "sess_parent_test_" + Date.now()

  // Test 1: Tracker Registration & Formatting
  console.log("\n[Test 1] Testing Global Swarm Tracker...")
  globalTracker.register({
    id: "task_backend_001",
    teamName: "Backend",
    agentType: "backend-architect",
    sessionId: "sess_backend_001",
    parentSessionId: parentSession,
    status: "running",
    prompt: "Design user database schema and migrations",
    createdAt: Date.now(),
  })

  globalTracker.register({
    id: "task_frontend_001",
    teamName: "Frontend",
    agentType: "frontend-developer",
    sessionId: "sess_frontend_001",
    parentSessionId: parentSession,
    status: "running",
    prompt: "Implement dashboard responsive UI components",
    createdAt: Date.now(),
  })

  const tree = globalTracker.formatTree(parentSession)
  console.log("Generated Swarm Tree:\n" + tree)
  assert.ok(tree.includes("backend-architect"), "Tree should contain backend member")
  assert.ok(tree.includes("frontend-developer"), "Tree should contain frontend member")
  console.log("✓ Tracker hierarchical tree generation passed")

  // Test 2: Tools Execution (Status, Broadcast, Terminate)
  console.log("\n[Test 2] Testing Status & Broadcast Tools...")
  const mockCtx = {
    session: {
      prompt: async () => {},
      interrupt: async () => {},
    },
  } as any

  const statusTool = createStatusTool(mockCtx)
  const statusRes = await statusTool.execute({}, { sessionID: parentSession })
  assert.ok(statusRes.content.includes("backend-architect"), "Status output should reflect active members")
  console.log("✓ team_status execution verified")

  const broadcastTool = createBroadcastTool(mockCtx)
  const broadcastRes = await broadcastTool.execute(
    { message: "Steering: ensure all endpoints use JWT auth" },
    { sessionID: parentSession }
  )
  assert.ok(broadcastRes.content.includes("Broadcast delivered to 2 teammate(s)"), "Broadcast should confirm delivery")
  console.log("✓ team_broadcast execution verified")

  const terminateTool = createTerminateTool(mockCtx)
  const termRes = await terminateTool.execute(
    { target: "all" },
    { sessionID: parentSession }
  )
  assert.ok(termRes.content.includes("Terminated and cleaned up 2"), "Should terminate all 2 running workers")
  console.log("✓ team_terminate execution verified")

  console.log("\n==================================================")
  console.log(" ✓ All Agent-Teams v2 tests passed successfully!")
  console.log("==================================================")
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err)
  process.exit(1)
})
