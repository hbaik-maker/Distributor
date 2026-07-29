(function () {
  const BOXES_PER_PALLET = 50;
  const STORAGE_TYPES = ["냉동", "냉장", "상온"];
  const IMPORTANCE_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4, N: 5, UNKNOWN: 6 };

  const searchBox = document.getElementById("search-box");
  const importanceFilter = document.getElementById("importance-filter");
  const flagFilter = document.getElementById("flag-filter");
  const includedFilter = document.getElementById("included-filter");
  const rows = Array.from(document.querySelectorAll("#review-table tbody tr"));
  const visibleCount = document.getElementById("visible-count");

  function getActiveStorage() {
    const active = document.querySelector("#storage-toggle .storage-btn.active");
    return active ? active.dataset.storage : "ALL";
  }

  function rowMatches(row) {
    const search = searchBox.value.trim().toLowerCase();
    const importance = importanceFilter.value;
    const flag = flagFilter.value;
    const included = includedFilter.value;
    const storage = getActiveStorage();

    if (search && !row.dataset.search.includes(search)) return false;
    if (importance && row.dataset.importance !== importance) return false;
    if (storage !== "ALL" && row.dataset.storage !== storage) return false;
    if (flag && !(" " + row.dataset.flags + " ").includes(" " + flag + " ")) return false;
    if (included) {
      const checked = row.querySelector('input[type=checkbox]').checked;
      if (included === "yes" && !checked) return false;
      if (included === "no" && checked) return false;
    }
    return true;
  }

  function applyFilters() {
    let count = 0;
    for (const row of rows) {
      const match = rowMatches(row);
      row.style.display = match ? "" : "none";
      if (match) count++;
    }
    visibleCount.textContent = count + " / " + rows.length + " SKUs shown";
  }

  [searchBox, importanceFilter, flagFilter, includedFilter].forEach((el) => {
    el.addEventListener("input", applyFilters);
    el.addEventListener("change", applyFilters);
  });

  document.querySelectorAll("#storage-toggle .storage-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#storage-toggle .storage-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      applyFilters();
      recomputeTotalPallets();
    });
  });

  document.getElementById("select-visible").addEventListener("click", () => {
    for (const row of rows) {
      if (row.style.display !== "none") row.querySelector('input[type=checkbox]').checked = true;
    }
    recomputeTotalPallets();
  });
  document.getElementById("deselect-visible").addEventListener("click", () => {
    for (const row of rows) {
      if (row.style.display !== "none") row.querySelector('input[type=checkbox]').checked = false;
    }
    recomputeTotalPallets();
  });

  applyFilters();

  /* Live-recalculate estimated boxes and post-shipment days-of-supply as the
     Ship qty input is edited, without a page reload. */
  function fmt1(v) { return v === null ? "—" : (Math.round(v * 10) / 10).toString(); }
  function fmt2(v) { return v === null ? "—" : (Math.round(v * 100) / 100).toString(); }

  /* Total est. boxes/pallets across currently-included rows that also match
     the selected 보관(storage) type — frozen/chilled/ambient ship as separate
     pallet loads, so the total is scoped to whichever is picked. */
  function recomputeTotalPallets() {
    const storage = getActiveStorage();
    let totalBoxes = 0;
    let skuCount = 0;
    for (const row of rows) {
      const checkbox = row.querySelector('input[type=checkbox]');
      if (!checkbox.checked) continue;
      if (storage !== "ALL" && row.dataset.storage !== storage) continue;
      const qtyInput = row.querySelector(".qty-input");
      const qtyRaw = parseFloat(qtyInput.value);
      const qty = Number.isFinite(qtyRaw) ? Math.max(0, qtyRaw) : 0;
      const boxSize = row.dataset.boxSize ? parseFloat(row.dataset.boxSize) : null;
      skuCount++;
      if (boxSize) totalBoxes += qty / boxSize;
    }
    const el = document.getElementById("total-pallets-summary");
    if (el) el.textContent = `${fmt1(totalBoxes)} boxes ≈ ${fmt2(totalBoxes / BOXES_PER_PALLET)} pallets across ${skuCount} SKU${skuCount === 1 ? "" : "s"}`;
  }

  document.getElementById("review-table").addEventListener("input", (e) => {
    if (!e.target.classList.contains("qty-input")) return;
    const row = e.target.closest("tr");
    const hqQty = parseFloat(row.dataset.hqQty) || 0;
    const eastPosition = parseFloat(row.dataset.eastPosition) || 0;
    const eastAvgDaily = parseFloat(row.dataset.eastAvgDaily) || 0;
    const boxSize = row.dataset.boxSize ? parseFloat(row.dataset.boxSize) : null;

    const qtyRaw = parseFloat(e.target.value);
    const qty = Number.isFinite(qtyRaw) ? Math.max(0, qtyRaw) : 0;

    const boxes = boxSize ? qty / boxSize : null;
    const hqDays = eastAvgDaily > 0 ? (hqQty - qty) / eastAvgDaily : null;
    const eastDays = eastAvgDaily > 0 ? (eastPosition + qty) / eastAvgDaily : null;

    row.querySelector('[data-role="est-boxes"]').textContent = fmt1(boxes);
    row.querySelector('[data-role="hq-days"]').textContent = fmt1(hqDays);
    row.querySelector('[data-role="east-days"]').textContent = fmt1(eastDays);
    recomputeTotalPallets();
  });

  document.getElementById("review-table").addEventListener("change", (e) => {
    if (e.target.type === "checkbox") recomputeTotalPallets();
  });

  /* ---- Pallet-cap shaping: fit each storage type's shipment into a max
   * pallet budget for this week, prioritizing by 온라인 중요도 grade then by
   * urgency (lowest current EAST days-of-supply first). Always starts from
   * each SKU's suggested quantity, not whatever is currently in the box, so
   * re-applying with different caps is predictable rather than compounding. */
  function shapeToPalletCap(storageType, capPallets, targetDays) {
    const maxBoxes = capPallets * BOXES_PER_PALLET;
    const candidateRows = rows.filter((row) => row.dataset.storage === storageType && row.querySelector('input[type=checkbox]').checked);

    const withPriority = candidateRows.map((row) => {
      const importance = row.dataset.importance;
      const eastPosition = parseFloat(row.dataset.eastPosition) || 0;
      const eastAvgDaily = parseFloat(row.dataset.eastAvgDaily) || 0;
      const eastDaysBefore = eastAvgDaily > 0 ? eastPosition / eastAvgDaily : Infinity;
      const grFewCheckbox = row.querySelector(".grfew-checkbox");
      // GR_Few SKUs are deliberately minimized to EAST already (cheaper to
      // ship direct from West) — they should be the first cut when fitting
      // into a pallet budget, below even UNKNOWN-grade (rank 6) items.
      const rank = (grFewCheckbox && grFewCheckbox.checked) ? 7 : (IMPORTANCE_RANK[importance] ?? 6);
      return { row, priority: [rank, eastDaysBefore] };
    });
    withPriority.sort((a, b) => (a.priority[0] - b.priority[0]) || (a.priority[1] - b.priority[1]));

    let runningBoxes = 0;
    withPriority.forEach(({ row }) => {
      const baselineQty = parseFloat(row.dataset.finalQtyComputed) || 0;
      const boxSize = row.dataset.boxSize ? parseFloat(row.dataset.boxSize) : null;
      const eastPosition = parseFloat(row.dataset.eastPosition) || 0;
      const eastAvgDaily = parseFloat(row.dataset.eastAvgDaily) || 0;
      let newQty = baselineQty;
      let reduced = false;
      if (boxSize) {
        const skuBoxes = baselineQty / boxSize;
        if (runningBoxes + skuBoxes <= maxBoxes + 1e-9) {
          runningBoxes += skuBoxes;
        } else {
          const remaining = Math.max(0, maxBoxes - runningBoxes);
          newQty = Math.round(remaining * boxSize);
          runningBoxes = maxBoxes;
          reduced = newQty < baselineQty;
        }
      }
      // Rows with no box size can't be measured in pallets — leave them untouched and out of the budget.

      const qtyInput = row.querySelector(".qty-input");
      qtyInput.value = newQty;
      qtyInput.dispatchEvent(new Event("input", { bubbles: true }));
      row.querySelector('input[type=checkbox]').checked = newQty > 0;

      const flagsCell = row.querySelector('[data-col="flags"]');
      const flagName = "PALLET_CAP_UNDERSUPPLIED";
      const currentFlags = (row.dataset.flags || "").split(/\s+/).filter(Boolean);
      const existingIdx = currentFlags.indexOf(flagName);
      let shouldFlag = false;
      if (reduced && eastAvgDaily > 0) {
        const postDays = (eastPosition + newQty) / eastAvgDaily;
        shouldFlag = postDays < targetDays - 1e-9;
      }
      if (shouldFlag && existingIdx === -1) {
        currentFlags.push(flagName);
        flagsCell.insertAdjacentHTML("beforeend", ` <span class="badge badge-danger">${flagName}</span>`);
      } else if (!shouldFlag && existingIdx !== -1) {
        currentFlags.splice(existingIdx, 1);
        const badge = Array.from(flagsCell.querySelectorAll(".badge")).find((b) => b.textContent === flagName);
        if (badge) badge.remove();
      }
      row.dataset.flags = currentFlags.join(" ");
      const capFlagInput = document.getElementById(`capflag_${row.dataset.itemId}`);
      if (capFlagInput) capFlagInput.value = shouldFlag ? flagName : "";
    });
  }

  const applyCapsBtn = document.getElementById("apply-pallet-caps");
  if (applyCapsBtn) {
    applyCapsBtn.addEventListener("click", () => {
      const targetDays = parseFloat(document.getElementById("review-table").dataset.targetDays) || 21;
      const caps = STORAGE_TYPES
        .map((t) => ({ type: t, val: parseFloat(document.getElementById(`cap-${t}`).value) }))
        .filter((c) => Number.isFinite(c.val) && c.val >= 0);
      if (!caps.length) { alert("Enter a max pallet number for at least one storage type first."); return; }
      const label = caps.map((c) => `${c.type}: ${c.val}`).join(", ");
      if (!confirm(`This resets Ship qty to the suggested amount for ${label}, then reduces lowest-priority SKUs to fit. Continue?`)) return;
      caps.forEach((c) => shapeToPalletCap(c.type, c.val, targetDays));
      applyFilters();
      recomputeTotalPallets();
    });
  }

  /* ---- Column sorting (click a sortable header to toggle asc/desc) ---- */
  const LS_COLUMN_ORDER = "wooltari_column_order";
  const sortState = { col: null, dir: "asc" };

  function getSortValue(row, colKey) {
    const cell = row.querySelector(`[data-col="${colKey}"]`);
    if (!cell) return null;
    if (colKey === "shipQty") {
      const input = cell.querySelector("input");
      const v = input ? parseFloat(input.value) : NaN;
      return Number.isFinite(v) ? v : null;
    }
    if (colKey === "flags") {
      const flagsAttr = (row.dataset.flags || "").trim();
      return flagsAttr ? flagsAttr.split(/\s+/).length : 0;
    }
    const text = cell.textContent.trim();
    if (text === "" || text === "—") return null;
    const v = parseFloat(text.replace(/,/g, ""));
    return Number.isFinite(v) ? v : null;
  }

  function updateSortIndicators() {
    document.querySelectorAll('#review-table thead th[data-sortable="true"]').forEach((th) => {
      const indicator = th.querySelector(".sort-indicator");
      if (th.dataset.col === sortState.col) indicator.textContent = sortState.dir === "asc" ? " ▲" : " ▼";
      else indicator.textContent = "";
    });
  }

  function sortByColumn(colKey) {
    sortState.dir = (sortState.col === colKey && sortState.dir === "asc") ? "desc" : "asc";
    sortState.col = colKey;
    const tbody = document.querySelector("#review-table tbody");
    const bodyRows = Array.from(tbody.querySelectorAll("tr"));
    const dirMul = sortState.dir === "asc" ? 1 : -1;
    bodyRows.sort((a, b) => {
      const va = getSortValue(a, colKey);
      const vb = getSortValue(b, colKey);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dirMul;
    });
    bodyRows.forEach((r) => tbody.appendChild(r));
    updateSortIndicators();
  }

  document.querySelectorAll('#review-table thead th[data-sortable="true"]').forEach((th) => {
    th.addEventListener("click", () => sortByColumn(th.dataset.col));
  });

  /* ---- Column reordering (drag & drop headers) ---- */
  function getColumnOrder() {
    return Array.from(document.querySelectorAll("#review-table thead th")).map((th) => th.dataset.col);
  }

  function applyColumnOrder(order) {
    const theadRow = document.querySelector("#review-table thead tr");
    order.forEach((key) => {
      const th = theadRow.querySelector(`[data-col="${key}"]`);
      if (th) theadRow.appendChild(th);
    });
    document.querySelectorAll("#review-table tbody tr").forEach((row) => {
      order.forEach((key) => {
        const cell = row.querySelector(`[data-col="${key}"]`);
        if (cell) row.appendChild(cell);
      });
    });
    try { localStorage.setItem(LS_COLUMN_ORDER, JSON.stringify(order)); } catch (e) { /* non-critical */ }
  }

  function applySavedColumnOrder() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(LS_COLUMN_ORDER) || "null"); } catch (e) { saved = null; }
    const defaultKeys = getColumnOrder().slice().sort();
    if (saved && Array.isArray(saved) && JSON.stringify([...saved].sort()) === JSON.stringify(defaultKeys)) {
      applyColumnOrder(saved);
    }
  }

  function moveColumn(fromKey, toKey) {
    if (fromKey === toKey) return;
    const order = getColumnOrder();
    const fromIdx = order.indexOf(fromKey);
    if (fromIdx === -1) return;
    order.splice(fromIdx, 1);
    const toIdx = order.indexOf(toKey);
    order.splice(toIdx === -1 ? order.length : toIdx, 0, fromKey);
    applyColumnOrder(order);
  }

  document.querySelectorAll("#review-table thead th").forEach((th) => {
    th.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", th.dataset.col);
      e.dataTransfer.effectAllowed = "move";
      th.classList.add("dragging");
    });
    th.addEventListener("dragend", () => th.classList.remove("dragging"));
    th.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      th.classList.add("drag-over");
    });
    th.addEventListener("dragleave", () => th.classList.remove("drag-over"));
    th.addEventListener("drop", (e) => {
      e.preventDefault();
      th.classList.remove("drag-over");
      const fromKey = e.dataTransfer.getData("text/plain");
      moveColumn(fromKey, th.dataset.col);
    });
  });

  applySavedColumnOrder();

  /* ---- Live settings: editing cap/floor/target days/box-round on the
   * review page re-runs the shipment calc for every SKU immediately, no
   * server round-trip needed. A row's Ship qty only gets overwritten if it
   * still shows exactly what the *previous* suggestion was — if you'd
   * already typed a custom number in, that's left alone (only "Suggested
   * qty" updates). The actual values get persisted server-side (including
   * re-scoring every diagnostic field for the Detailed export) on Save/
   * Finalize, since the four inputs below are inside the form. */
  function bindingConstraint(targetQty, capRoom, hqQty, desiredQty, minFloorQty) {
    const candidates = { TARGET: Math.max(targetQty, 0), CAP_40: Math.max(capRoom, 0), HQ_STOCK: Math.max(hqQty, 0) };
    let binding = "TARGET", bestVal = candidates.TARGET;
    for (const k of ["TARGET", "CAP_40", "HQ_STOCK"]) {
      if (candidates[k] < bestVal) { bestVal = candidates[k]; binding = k; }
    }
    if (binding === "TARGET") return (minFloorQty > desiredQty + 1e-9) ? "MIN_FLOOR" : "DEMAND";
    return binding;
  }

  function decideRounding(rawQty, boxSize, eastPosition, totalUnits, floorPct, capPct, boxRoundPct, zeroBoxRoundPct) {
    const wholeBoxes = Math.floor(rawQty / boxSize);
    const remainder = rawQty - wholeBoxes * boxSize;
    const remainderPct = remainder / boxSize;

    // The 0-vs-1-box boundary is a different decision from N-vs-(N+1): going
    // from 0 to 1 box is a 100% jump, so genuine (if small) unmet demand
    // below a full box shouldn't be silently zeroed out by boxRoundPct,
    // which is tuned for the N>=1 case. Mirrors decide_rounding in calc.py.
    if (wholeBoxes === 0 && rawQty > 0 && remainderPct >= (zeroBoxRoundPct || 0)) {
      const roundedUp = boxSize;
      if (eastPosition + roundedUp > capPct * totalUnits + 1e-9) return { finalQty: rawQty, flagFloor: false };
      return { finalQty: roundedUp, flagFloor: false };
    }

    if (remainderPct < boxRoundPct) {
      const roundedDown = wholeBoxes * boxSize;
      if (eastPosition + roundedDown < floorPct * totalUnits - 1e-9) return { finalQty: rawQty, flagFloor: true };
      return { finalQty: roundedDown, flagFloor: false };
    }
    const roundedUp = (wholeBoxes + 1) * boxSize;
    if (eastPosition + roundedUp > capPct * totalUnits + 1e-9) return { finalQty: rawQty, flagFloor: false };
    return { finalQty: roundedUp, flagFloor: false };
  }

  /* Kimchi products always ship in whole boxes, rounding UP by default
   * instead of the 30%-remainder rule. Rounding up past capPct is kept as
   * long as it stays under hardCapPct; at/beyond hardCapPct it rounds down
   * instead, unless that would breach floorPct, in which case it reverts
   * to rounding up regardless (floor protection wins). Mirrors
   * decide_rounding_kimchi in app/calc.py. */
  function decideRoundingKimchi(rawQty, boxSize, eastPosition, totalUnits, hqQty, floorPct, capPct, hardCapPct) {
    if (rawQty <= 1e-9) return 0;
    const wholeBoxes = Math.floor(rawQty / boxSize);
    const maxBoxesFromHq = hqQty > 0 ? Math.floor(hqQty / boxSize) : 0;
    const roundedUp = Math.min(wholeBoxes + 1, maxBoxesFromHq) * boxSize;
    const roundedDown = wholeBoxes * boxSize;

    const upShare = totalUnits ? (eastPosition + roundedUp) / totalUnits : 0;
    if (upShare < capPct - 1e-9) return roundedUp;
    if (upShare < hardCapPct - 1e-9) return roundedUp;

    const downShare = totalUnits ? (eastPosition + roundedDown) / totalUnits : 0;
    if (downShare < floorPct - 1e-9) return roundedUp;
    return roundedDown;
  }

  function computeShipmentFromRow(row, settings) {
    const hqQty = parseFloat(row.dataset.hqQty) || 0;
    const eastPosition = parseFloat(row.dataset.eastPosition) || 0;
    const totalUnits = parseFloat(row.dataset.totalUnits) || 0;
    const eastAvgDaily = parseFloat(row.dataset.eastAvgDaily) || 0;
    const boxSize = row.dataset.boxSize ? parseFloat(row.dataset.boxSize) : null;
    const totalAvgDaily = parseFloat(row.dataset.totalAvgDaily) || 0;
    const noSalesHistory = totalAvgDaily <= 0;
    const name = row.dataset.name || "";
    const grFewCheckbox = row.querySelector(".grfew-checkbox");
    const isGrFew = !!(grFewCheckbox && grFewCheckbox.checked);

    const isKimchi = !!(settings.kimchiEnabled && settings.kimchiKeyword && name.includes(settings.kimchiKeyword));
    // GR_Few is a manual per-SKU override and takes priority over the
    // automatic 김치 keyword match if both apply. Its cap and hard cap are
    // the same (15%) — no grace band, rounding up is only kept below 15%.
    let floorPct, capPct, hardCapPct;
    if (isGrFew) {
      floorPct = 0; capPct = 0.15; hardCapPct = 0.15;
    } else if (isKimchi) {
      floorPct = settings.kimchiFloorPct; capPct = settings.kimchiCapPct; hardCapPct = settings.kimchiHardCapPct;
    } else {
      floorPct = settings.floorPct; capPct = settings.capPct;
    }

    const desiredQty = Math.max(0, settings.targetDays * eastAvgDaily - eastPosition);
    const minFloorQty = Math.max(0, floorPct * totalUnits - eastPosition);
    const targetQty = Math.max(desiredQty, minFloorQty);
    const capRoom = capPct * totalUnits - eastPosition;
    const rawQty = Math.max(0, Math.min(targetQty, capRoom, hqQty));
    const binding = bindingConstraint(targetQty, capRoom, hqQty, desiredQty, minFloorQty);

    let finalQty = rawQty;
    if (boxSize && (isGrFew || isKimchi)) {
      finalQty = decideRoundingKimchi(rawQty, boxSize, eastPosition, totalUnits, hqQty, floorPct, capPct, hardCapPct);
    } else if (boxSize) {
      finalQty = decideRounding(rawQty, boxSize, eastPosition, totalUnits, floorPct, capPct, settings.boxRoundPct, settings.zeroBoxRoundPct).finalQty;
    }
    finalQty = Math.round(finalQty);

    const flags = [];
    if (isGrFew) flags.push("GR_FEW_OVERRIDE");
    else if (isKimchi) flags.push("KIMCHI_OVERRIDE");
    if (noSalesHistory) flags.push("NO_SALES_HISTORY");
    if (finalQty > 0) {
      const statusOnline = (row.dataset.statusOnline || "").trim().toLowerCase();
      const daysSinceLastSale = row.dataset.daysSinceLastSale ? parseFloat(row.dataset.daysSinceLastSale) : null;
      const isActiveStatus = statusOnline === "active";
      const isStaleSale = daysSinceLastSale !== null && daysSinceLastSale >= settings.staleSaleDaysThreshold;
      if (!isActiveStatus || isStaleSale) flags.push("POSSIBLY_DISCONTINUED");
    }
    if (minFloorQty > desiredQty + 1e-9) flags.push("MINIMUM_FLOOR_APPLIED");
    if (hqQty <= 0) flags.push("HQ_OUT_OF_STOCK");
    else if (binding === "HQ_STOCK" && hqQty < minFloorQty - 1e-9) flags.push("HQ_SHORTAGE_BELOW_MINIMUM_FLOOR");
    if (eastAvgDaily > 0) {
      const postEastDays = (eastPosition + finalQty) / eastAvgDaily;
      if ((binding === "CAP_40" || binding === "HQ_STOCK") && postEastDays < settings.targetDays - 1e-9) flags.push("EAST_UNDERSUPPLIED");
      const postWestDays = (hqQty - finalQty) / eastAvgDaily;
      if (postWestDays < settings.targetDays - 1e-9) flags.push("WEST_UNDERSUPPLIED");
    }
    return { finalQtyComputed: finalQty, includedDefault: finalQty > 0, flags };
  }

  /* Applies a freshly computed shipment to a single row's DOM (suggested
   * qty, ship qty if it wasn't manually overridden, est boxes/days, flag
   * badges). Shared by the bulk recompute (settings panel changed) and the
   * single-row recompute (a row's GR_Few checkbox was toggled). */
  function updateRowFromShipment(row, shipment) {
    const qtyInput = row.querySelector(".qty-input");
    const checkbox = row.querySelector('input[type=checkbox]');
    const oldSuggested = parseFloat(row.dataset.finalQtyComputed);
    const currentDomQty = parseFloat(qtyInput.value);
    const wasAtSuggestion = Number.isFinite(currentDomQty) && currentDomQty === oldSuggested;

    row.dataset.finalQtyComputed = shipment.finalQtyComputed;
    row.querySelector('[data-col="suggestedQty"]').textContent = shipment.finalQtyComputed;
    if (wasAtSuggestion) {
      qtyInput.value = shipment.finalQtyComputed;
      checkbox.checked = shipment.includedDefault;
    }
    const effQty = wasAtSuggestion ? shipment.finalQtyComputed : currentDomQty;
    const boxSize = row.dataset.boxSize ? parseFloat(row.dataset.boxSize) : null;
    const eastPosition = parseFloat(row.dataset.eastPosition) || 0;
    const hqQty = parseFloat(row.dataset.hqQty) || 0;
    const eastAvgDaily = parseFloat(row.dataset.eastAvgDaily) || 0;
    const boxes = boxSize ? effQty / boxSize : null;
    const hqDays = eastAvgDaily > 0 ? (hqQty - effQty) / eastAvgDaily : null;
    const eastDays = eastAvgDaily > 0 ? (eastPosition + effQty) / eastAvgDaily : null;
    row.querySelector('[data-role="est-boxes"]').textContent = fmt1(boxes);
    row.querySelector('[data-role="hq-days"]').textContent = fmt1(hqDays);
    row.querySelector('[data-role="east-days"]').textContent = fmt1(eastDays);

    const flagsCell = row.querySelector('[data-col="flags"]');
    flagsCell.innerHTML = shipment.flags
      .map((f) => `<span class="badge ${["HQ_OUT_OF_STOCK", "HQ_SHORTAGE_BELOW_MINIMUM_FLOOR"].indexOf(f) !== -1 ? "badge-danger" : "badge-warn"}">${f}</span>`)
      .join(" ");
    row.dataset.flags = shipment.flags.join(" ");
  }

  function recomputeWithSettings(newSettings) {
    document.getElementById("review-table").dataset.targetDays = newSettings.targetDays;
    rows.forEach((row) => updateRowFromShipment(row, computeShipmentFromRow(row, newSettings)));
    applyFilters();
    recomputeTotalPallets();
  }

  const capInput = document.getElementById("set-cap-pct");
  const floorInput = document.getElementById("set-floor-pct");
  const daysInput = document.getElementById("set-target-days");
  const roundInput = document.getElementById("set-box-round-pct");
  const zeroBoxRoundInput = document.getElementById("set-zero-box-round-pct");
  const staleSaleDaysInput = document.getElementById("set-stale-sale-days-threshold");
  const settingsWarning = document.getElementById("settings-inline-warning");
  const kimchiEnabledInput = document.getElementById("set-kimchi-enabled");
  const kimchiKeywordInput = document.getElementById("set-kimchi-keyword");
  const kimchiFloorInput = document.getElementById("set-kimchi-floor-pct");
  const kimchiCapInput = document.getElementById("set-kimchi-cap-pct");
  const kimchiHardCapInput = document.getElementById("set-kimchi-hard-cap-pct");

  function getCurrentSettings() {
    return {
      capPct: parseFloat(capInput.value) / 100,
      floorPct: parseFloat(floorInput.value) / 100,
      targetDays: parseInt(daysInput.value, 10),
      boxRoundPct: parseFloat(roundInput.value) / 100,
      zeroBoxRoundPct: parseFloat(zeroBoxRoundInput ? zeroBoxRoundInput.value : NaN) / 100,
      staleSaleDaysThreshold: parseInt(staleSaleDaysInput ? staleSaleDaysInput.value : NaN, 10),
      kimchiEnabled: !!(kimchiEnabledInput && kimchiEnabledInput.checked),
      kimchiKeyword: kimchiKeywordInput ? kimchiKeywordInput.value.trim() : "김치",
      kimchiFloorPct: parseFloat(kimchiFloorInput ? kimchiFloorInput.value : NaN) / 100,
      kimchiCapPct: parseFloat(kimchiCapInput ? kimchiCapInput.value : NaN) / 100,
      kimchiHardCapPct: parseFloat(kimchiHardCapInput ? kimchiHardCapInput.value : NaN) / 100,
    };
  }

  document.getElementById("review-table").addEventListener("change", (e) => {
    if (!e.target.classList.contains("grfew-checkbox")) return;
    const row = e.target.closest("tr");
    updateRowFromShipment(row, computeShipmentFromRow(row, getCurrentSettings()));
    applyFilters();
    recomputeTotalPallets();
  });

  if (capInput && floorInput && daysInput && roundInput) {
    const applySettings = () => {
      const { capPct, floorPct, targetDays, boxRoundPct, zeroBoxRoundPct, staleSaleDaysThreshold, kimchiEnabled, kimchiKeyword, kimchiFloorPct, kimchiCapPct, kimchiHardCapPct } = getCurrentSettings();
      const valid = Number.isFinite(capPct) && capPct > 0 && capPct <= 1
        && Number.isFinite(floorPct) && floorPct >= 0 && floorPct < capPct
        && Number.isFinite(targetDays) && targetDays > 0
        && Number.isFinite(boxRoundPct) && boxRoundPct >= 0 && boxRoundPct <= 1
        && Number.isFinite(zeroBoxRoundPct) && zeroBoxRoundPct >= 0 && zeroBoxRoundPct <= boxRoundPct
        && Number.isFinite(staleSaleDaysThreshold) && staleSaleDaysThreshold >= 1
        && Number.isFinite(kimchiFloorPct) && kimchiFloorPct >= 0
        && Number.isFinite(kimchiCapPct) && kimchiFloorPct < kimchiCapPct
        && Number.isFinite(kimchiHardCapPct) && kimchiCapPct < kimchiHardCapPct && kimchiHardCapPct <= 1;
      if (!valid) {
        settingsWarning.textContent = "Floor % must be less than Cap %, Cap % must be 1-100, target days must be positive, zero-box threshold must be between 0 and the box rounding threshold, stale sale threshold must be at least 1 day, and 김치 floor < cap < hard cap.";
        return;
      }
      settingsWarning.textContent = "";
      recomputeWithSettings({
        capPct, floorPct, targetDays, boxRoundPct, zeroBoxRoundPct, staleSaleDaysThreshold,
        kimchiEnabled, kimchiKeyword, kimchiFloorPct, kimchiCapPct, kimchiHardCapPct,
      });
    };
    [capInput, floorInput, daysInput, roundInput, zeroBoxRoundInput, staleSaleDaysInput, kimchiEnabledInput, kimchiKeywordInput, kimchiFloorInput, kimchiCapInput, kimchiHardCapInput]
      .filter(Boolean)
      .forEach((el) => el.addEventListener("input", applySettings));
  }
})();
