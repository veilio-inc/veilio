export class QuasarLedgerReconciler {
  reconcile(batchEntries: string[]): number {
    const settledTotal = batchEntries.length
    return settledTotal
  }
}
