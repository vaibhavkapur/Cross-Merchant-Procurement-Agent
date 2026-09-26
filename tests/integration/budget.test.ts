import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetLedger, SqliteDriver, migrate, seedDatabase } from "@procurement/domain";

test("concurrent reservations cannot overspend the cost centre", async () => {
  const driver = new SqliteDriver(":memory:");
  await migrate(driver);
  await seedDatabase(driver);
  for (let i = 0; i < 4; i++) {
    await driver.run(
      `INSERT INTO procurement_requests(id, organization_id, buyer_id, cost_center_id, product_constraints_json, quantity, delivery_deadline, currency, budget_minor, destination_id, allowed_merchants_json, status, version, missing_fields_json, simulation_json, created_at, updated_at)
       VALUES (?, 'org_acme', 'buyer_alice', 'cc_it_hardware', '{}', 1, '2026-10-02T00:00:00Z', 'USD', 200000, 'dest_hq', '[]', 'draft', 1, '[]', '{}', '2026-09-26T12:00:00Z', '2026-09-26T12:00:00Z')`,
      [`pr_${i}`],
    );
  }
  const now = "2026-09-26T12:00:00.000Z";
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      driver.transaction(async (tx) => {
        const ledger = new BudgetLedger(tx);
        return ledger.reserve({
          cost_center_id: "cc_it_hardware",
          procurement_request_id: `pr_${i}`,
          execution_reference: `att_${i}`,
          amount_minor: 100000,
          currency: "USD",
          now,
        });
      }),
    ),
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 2);
  assert.equal(failed.length, 2);
  const view = await new BudgetLedger(driver).view("cc_it_hardware");
  assert.equal(view.active_reserved_minor, 200000);
  assert.equal(view.available_minor, 50000);
  await driver.close();
});
