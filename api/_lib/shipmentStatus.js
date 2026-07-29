// Shared shipment-level status roll-up, used by both execute and rollback
// routes so the two can never drift out of sync with each other.
function computeShipmentStatus(legStatuses) {
  if (legStatuses.length && legStatuses.every((s) => s === "executed")) return "shipped";
  if (legStatuses.some((s) => s === "executed")) return "partially_shipped";
  return "planned";
}

module.exports = { computeShipmentStatus };
