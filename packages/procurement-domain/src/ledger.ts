import type { SqlExecutor } from "./db/driver.ts";
import { assertNonNegativeMinor, subMinor, type Minor } from "./money.ts";
import { Store } from "./store.ts";
import type { BudgetReservation, CostCenter } from "./types.ts";
import { DomainError, newId } from "./util.ts";

export interface BudgetView {
  cost_center: CostCenter;
  active_reserved_minor: Minor;
  available_minor: Minor;
}

/**
 * Budget ledger.
 *
 *   available = allocated − committed − Σ(active reservations)
 *
 * `reserve` must be called inside the same transaction that records the
 * checkout attempt and outbox message so that a crash between the reservation
 * and the execution can never leave money reserved for an attempt that does
 * not exist (or vice versa). The write lock (BEGIN IMMEDIATE / FOR UPDATE)
 * serialises concurrent approvals against the same cost centre.
 */
export class BudgetLedger {
  private readonly tx: SqlExecutor;
  constructor(tx: SqlExecutor) {
    this.tx = tx;
  }

  private get store(): Store {
    return new Store(this.tx);
  }

  async view(costCenterId: string, forUpdate = false): Promise<BudgetView> {
    const cc = await this.store.getCostCenter(costCenterId, forUpdate);
    if (!cc) throw new DomainError("cost_center_not_found", `Cost centre ${costCenterId} not found`, 404);
    const reserved = await this.store.activeReservationTotal(costCenterId);
    const available = subMinor(subMinor(cc.allocated_minor, cc.committed_minor), reserved);
    return { cost_center: cc, active_reserved_minor: reserved, available_minor: available };
  }

  /**
   * Reserve `amount` for `executionReference`. Idempotent: an existing
   * reservation for the same reference is returned untouched, so a retried
   * execute call cannot double-reserve.
   */
  async reserve(input: { cost_center_id: string; procurement_request_id: string; execution_reference: string; amount_minor: Minor; currency: string; now: string }): Promise<BudgetReservation> {
    assertNonNegativeMinor(input.amount_minor, "reservation amount");
    const existing = await this.store.getReservationByReference(input.execution_reference);
    if (existing) return existing;

    const view = await this.view(input.cost_center_id, true);
    if (view.cost_center.currency !== input.currency) {
      throw new DomainError("currency_mismatch", `Cost centre currency ${view.cost_center.currency} does not match ${input.currency}`, 422);
    }
    if (view.available_minor < input.amount_minor) {
      throw new DomainError("insufficient_budget", `Insufficient budget: available ${view.available_minor}, requested ${input.amount_minor}`, 409, {
        available_minor: view.available_minor,
        requested_minor: input.amount_minor,
      });
    }
    const reservation: BudgetReservation = {
      id: newId("res"),
      cost_center_id: input.cost_center_id,
      procurement_request_id: input.procurement_request_id,
      execution_reference: input.execution_reference,
      amount_minor: input.amount_minor,
      currency: input.currency,
      state: "active",
      created_at: input.now,
      resolved_at: null,
    };
    await this.store.insertReservation(reservation);
    return reservation;
  }

  /** Convert an active reservation into committed spend (order confirmed). */
  async commit(executionReference: string, now: string): Promise<void> {
    const r = await this.store.getReservationByReference(executionReference);
    if (!r) throw new DomainError("reservation_not_found", `No reservation for ${executionReference}`, 404);
    if (r.state !== "active") return; // already resolved: idempotent
    const cc = await this.store.getCostCenter(r.cost_center_id, true);
    if (!cc) throw new DomainError("cost_center_not_found", `Cost centre ${r.cost_center_id} not found`, 404);
    await this.store.updateCostCenterCommitted(cc.id, cc.committed_minor + r.amount_minor);
    await this.store.resolveReservation(r.id, "committed", now);
  }

  /** Release an active reservation (order rejected / attempt abandoned). */
  async release(executionReference: string, now: string): Promise<void> {
    const r = await this.store.getReservationByReference(executionReference);
    if (!r || r.state !== "active") return;
    await this.store.resolveReservation(r.id, "released", now);
  }
}
