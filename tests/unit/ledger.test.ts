import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetLedger, SqliteDriver, migrate, seedDatabase } from "@procurement/domain";

async function stubRequest(driver: SqliteDriver, id: string): Promise<void> {
  await driver.run(
    `INSERT INTO procurement_requests(id, organization_id, buyer_id, cost_center_id, product_constraints_json, quantity, delivery_deadline, currency, budget_minor, destination_id, allowed_merchants_json, status, version, missing_fields_json, simulation_json, created_at, updated_at)
     VALUES (?, 'org_acme', 'buyer_alice', 'cc_it_hardware', '{}', 1, '2026-10-02T00:00:00Z', 'USD', 200000, 'dest_hq', '[]', 'draft', 1, '[]', '{}', '2026-09-26T12:00:00Z', '2026-09-26T12:00:00Z')`,
    [id],
  );
}

test("repeated reserve for the same execution reference does not double-reserve", async () => {
  const driver = new SqliteDriver(":memory:");
  await migrate(driver);
  await seedDatabase(driver);
  await stubRequest(driver, "pr_x");
  const now = "2026-09-26T12:00:00.000Z";
  const first = await driver.transaction(async (tx) => {
    const ledger = new BudgetLedger(tx);
    return ledger.reserve({ cost_center_id: "cc_it_hardware", procurement_request_id: "pr_x", execution_reference: "att_1", amount_minor: 190000, currency: "USD", now });
  });
  const second = await driver.transaction(async (tx) => {
    const ledger = new BudgetLedger(tx);
    return ledger.reserve({ cost_center_id: "cc_it_hardware", procurement_request_id: "pr_x", execution_reference: "att_1", amount_minor: 190000, currency: "USD", now });
  });
  assert.equal(first.id, second.id);
  const view = await new BudgetLedger(driver).view("cc_it_hardware");
  assert.equal(view.active_reserved_minor, 190000);
  assert.equal(view.available_minor, 250000 - 190000);
  await driver.close();
});

test("available = allocated - committed - active reservations", async () => {
  const driver = new SqliteDriver(":memory:");
  await migrate(driver);
  await seedDatabase(driver);
  await stubRequest(driver, "pr_1");
  await stubRequest(driver, "pr_2");
  await driver.transaction(async (tx) => {
    const ledger = new BudgetLedger(tx);
    await ledger.reserve({ cost_center_id: "cc_it_hardware", procurement_request_id: "pr_1", execution_reference: "att_1", amount_minor: 100000, currency: "USD", now: "2026-09-26T12:00:00.000Z" });
    await ledger.commit("att_1", "2026-09-26T12:01:00.000Z");
    await ledger.reserve({ cost_center_id: "cc_it_hardware", procurement_request_id: "pr_2", execution_reference: "att_2", amount_minor: 50000, currency: "USD", now: "2026-09-26T12:02:00.000Z" });
  });
  const view = await new BudgetLedger(driver).view("cc_it_hardware");
  assert.equal(view.cost_center.committed_minor, 100000);
  assert.equal(view.active_reserved_minor, 50000);
  assert.equal(view.available_minor, 100000);
  await driver.close();
});
