import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTransition, canTransition } from "@procurement/domain";

test("workflow transitions match the plan state machine", () => {
  assert.equal(canTransition("draft", "collecting_quotes"), true);
  assert.equal(canTransition("comparing", "awaiting_approval"), true);
  assert.equal(canTransition("approved", "awaiting_approval"), true);
  assert.equal(canTransition("completing", "reconciliation_required"), true);
  assert.equal(canTransition("reconciliation_required", "ordered"), true);
  assert.equal(canTransition("ordered", "draft"), false);
  assert.throws(() => assertTransition("ordered", "cancelled"));
});
