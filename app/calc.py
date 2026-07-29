"""Core West -> East distribution allocation algorithm.

Reads the 'boxhero' (mother source of stock) and 'scm_sales' (sales history,
used only to estimate demand) sheets from the weekly Wooltari Datasource
Excel export and computes a recommended per-SKU shipment quantity from
HQ WEST to the EAST center.
"""
import math

import pandas as pd

# --- Exact column names from the Wooltari Datasource workbook ---------
BOXHERO_SHEET = "boxhero"
SCM_SALES_SHEET = "scm_sales"

COL_SKU = "SKU"
COL_BARCODE = "Barcode"
COL_NAME = "Name"
COL_ENGLISH_NAME = "English Name"
COL_CATEGORY = "Category"
COL_BOX_SIZE = "입수/박스"
COL_STATUS_ONLINE = "Status.Online"
COL_IMPORTANCE = "온라인 중요도"
COL_STORAGE = "보관"
COL_COST = "Cost"
COL_CS_PER_PLT = "CS/PLT"
COL_CBM_EA = "CBM(EA)"

# Optional — used only as a CBM(EA) fallback chain when that column itself is
# blank for a given SKU. Not in REQUIRED_BOXHERO_COLS: an older datasource
# export missing these entirely is treated the same as a blank cell.
COL_CTN_LENGTH_MM = "카툰사이즈 mm (가로)"
COL_CTN_WIDTH_MM = "카툰사이즈 mm (세로)"
COL_CTN_HEIGHT_MM = "카툰사이즈 mm (높이)"
COL_UNIT_LENGTH_MM = "unit_length_mm"
COL_UNIT_WIDTH_MM = "unit_width_mm"
COL_UNIT_HEIGHT_MM = "unit_height_mm"
COL_CBM_CTN = "CBM(CTN)"
OPTIONAL_CBM_FALLBACK_COLS = [
    COL_UNIT_LENGTH_MM, COL_UNIT_WIDTH_MM, COL_UNIT_HEIGHT_MM,
    COL_CBM_CTN, COL_CTN_LENGTH_MM, COL_CTN_WIDTH_MM, COL_CTN_HEIGHT_MM,
]

MM3_PER_CBM = 1_000_000_000.0  # 1 m^3 = 1000mm * 1000mm * 1000mm
# 50 boxes/pallet at ~0.036 CBM/box observed average -> ~1.8 CBM/pallet. When
# a SKU has no CBM data at all (not even carton/unit dimensions), this nominal
# per-EA footprint keeps it from being silently excluded from pallet-total
# estimates without materially skewing them.
CBM_EA_NOMINAL_DEFAULT = 0.001
# Real pallet capacity (50 boxes/pallet at ~0.036 CBM/box observed average).
# Only used as a fallback to ESTIMATE CS/PLT when that column itself is
# blank for a SKU — the real CS/PLT value is authoritative for pallet
# estimates whenever it's present (confirmed directly against how the
# comparison tool this was benchmarked against computes pallets: whole boxes
# shipped / CS/PLT, not a CBM-based total).
CBM_PER_PALLET = 1.8

BOXES_PER_PALLET = 50
IMPORTANCE_GRADES = ["S", "A", "B", "C", "D", "N", "UNKNOWN"]
STORAGE_TYPES = ["냉동", "냉장", "상온"]

COL_HQ_ONLINE = "Qty(00_HQ_Online)"
COL_LOCAL_TRANS_ONLINE = "Qty(10_LOCAL_TRANS_ONLINE)"
COL_KPAC_ONLINE = "Qty(10_KPAC_Online)"
COL_PA_ART = "Qty(10_PA_ART)"
COL_PA_ONLINE = "Qty(10_PA_ONLINE)"
COL_PA_1_PRE = "Qty(30_PA_1_PRE_STORAGE)"
COL_PA_2_PRE = "Qty(30_PA_2_PRE_STORAGE)"
COL_PA_1_AIR_PRE = "Qty(30_PA_1_AIR_PRE_STORAGE)"
COL_PA_2_AIR_PRE = "Qty(30_PA_2_AIR_PRE_STORAGE)"

SCM_COL_SKU = "sku"
SCM_COL_5D_AVG = "5d_avg_daily_qty"
SCM_COL_30D_AVG = "30d_avg_daily_qty"
SCM_COL_90D_AVG = "90d_avg_daily_qty"
SCM_COL_5D_EAST = "5d_east_qty"
SCM_COL_30D_EAST = "30d_east_qty"
SCM_COL_90D_EAST = "90d_east_qty"
SCM_COL_5D_WEST = "5d_west_qty"
SCM_COL_30D_WEST = "30d_west_qty"
SCM_COL_90D_WEST = "90d_west_qty"
SCM_COL_LAST_SALE_DATE = "last_sale_date"
SCM_COL_REFRESHED_AT = "refreshed_at"

REQUIRED_BOXHERO_COLS = [
    COL_SKU, COL_BARCODE, COL_NAME, COL_ENGLISH_NAME, COL_CATEGORY,
    COL_BOX_SIZE, COL_STATUS_ONLINE, COL_IMPORTANCE, COL_STORAGE, COL_HQ_ONLINE, COL_LOCAL_TRANS_ONLINE,
    COL_KPAC_ONLINE, COL_PA_ART, COL_PA_ONLINE, COL_PA_1_PRE, COL_PA_2_PRE,
    COL_PA_1_AIR_PRE, COL_PA_2_AIR_PRE,
    COL_COST, COL_CS_PER_PLT, COL_CBM_EA,
]
REQUIRED_SCM_COLS = [
    SCM_COL_SKU, SCM_COL_5D_AVG, SCM_COL_30D_AVG, SCM_COL_90D_AVG,
    SCM_COL_5D_EAST, SCM_COL_30D_EAST, SCM_COL_90D_EAST,
    SCM_COL_5D_WEST, SCM_COL_30D_WEST, SCM_COL_90D_WEST,
    SCM_COL_LAST_SALE_DATE, SCM_COL_REFRESHED_AT,
]

DEFAULT_SETTINGS = {
    "cap_pct": 0.40,        # EAST position must never exceed this share of total_units
    "floor_pct": 0.25,      # EAST position should be at least this share (stockout protection)
    "target_days": 21,      # days of EAST demand to ship for
    "box_round_pct": 0.30,  # round up to a full box once raw_qty >= this fraction of box_size
    "zero_box_round_pct": 0.05,  # for demand below one full box, ship it anyway once raw_qty >= this fraction of box_size
    # Products whose name contains kimchi_keyword use their own floor/cap band
    # and always ship in whole boxes (see decide_rounding_kimchi).
    "kimchi_override_enabled": True,
    "kimchi_keyword": "김치",
    "kimchi_floor_pct": 0.10,
    "kimchi_cap_pct": 0.15,
    "kimchi_hard_cap_pct": 0.20,
    # Diagnostic only — flags (never suppresses) a shipment when the SKU
    # isn't marked ACTIVE, or hasn't actually sold in this many days, even
    # though its historical average is still driving a nonzero shipment.
    "stale_sale_days_threshold": 45,
    # Below a full box, a shipment under this many EA is too small a loose
    # pick to bother the warehouse with. Skipped outright unless there's
    # genuine sales history (this run's highest of the 5d/30d/90d average),
    # in which case it rounds up to a full box instead (still subject to the
    # cap) — see decide_rounding. This can leave EAST below the floor for
    # these specific low/no-demand SKUs; that's intentional, not a bug.
    "no_box_min_ea": 5,
    # Low priority: a less-than-a-box shipment isn't critical enough to risk
    # HQ's own supply — skip it if HQ has under this many days of its own
    # runway left for the SKU (at the EAST demand rate), regardless of sales
    # history or box-rounding thresholds. See decide_rounding.
    "no_box_hq_min_days": 10,
    # Per-storage-type overrides (냉동/냉장/상온), e.g. {"상온": {"floor_pct": 0.10}}.
    # Only the keys present for a given storage type override the base
    # settings above — anything unset inherits the shared value. Kimchi/GR_Few
    # overrides still take priority over whichever floor/cap this resolves to
    # (unchanged — those are product-name/manual overrides, not storage-based).
    "storage_overrides": {},
}

STORAGE_OVERRIDABLE_KEYS = ["cap_pct", "floor_pct", "target_days", "box_round_pct", "zero_box_round_pct", "no_box_min_ea", "no_box_hq_min_days"]


def _effective_settings_for_storage(settings, storage):
    """Merge this storage type's override (if any) over the base settings.
    Returns `settings` unchanged when there's no override for this storage —
    cheap in the common case where no per-storage overrides are configured.
    """
    overrides = (settings.get("storage_overrides") or {}).get(storage) or {}
    if not overrides:
        return settings
    effective = dict(settings)
    for key in STORAGE_OVERRIDABLE_KEYS:
        if overrides.get(key) is not None:
            effective[key] = overrides[key]
    return effective


class DataValidationError(Exception):
    pass


def _clean_numeric(series):
    return pd.to_numeric(series, errors="coerce").fillna(0)


def load_workbook_frames(file_path_or_buffer):
    """Read and lightly validate the two sheets we need."""
    try:
        xls = pd.ExcelFile(file_path_or_buffer)
    except Exception as exc:
        raise DataValidationError(f"Could not open the Excel file: {exc}") from exc

    for sheet in (BOXHERO_SHEET, SCM_SALES_SHEET):
        if sheet not in xls.sheet_names:
            raise DataValidationError(
                f"Required sheet '{sheet}' not found. Sheets present: {xls.sheet_names}"
            )

    boxhero = pd.read_excel(xls, sheet_name=BOXHERO_SHEET)
    scm_sales = pd.read_excel(xls, sheet_name=SCM_SALES_SHEET)

    missing_bh = [c for c in REQUIRED_BOXHERO_COLS if c not in boxhero.columns]
    if missing_bh:
        raise DataValidationError(
            f"'{BOXHERO_SHEET}' sheet is missing expected columns: {missing_bh}"
        )
    missing_scm = [c for c in REQUIRED_SCM_COLS if c not in scm_sales.columns]
    if missing_scm:
        raise DataValidationError(
            f"'{SCM_SALES_SHEET}' sheet is missing expected columns: {missing_scm}"
        )

    return boxhero, scm_sales


def _binding_constraint(target_qty, cap_room, hq_qty, desired_qty, min_floor_qty):
    candidates = {
        "TARGET": max(target_qty, 0.0),
        "CAP_40": max(cap_room, 0.0),
        "HQ_STOCK": max(hq_qty, 0.0),
    }
    binding = min(candidates, key=candidates.get)
    if binding == "TARGET":
        if min_floor_qty > desired_qty + 1e-9:
            return "MIN_FLOOR"
        return "DEMAND"
    return binding


def decide_rounding(raw_qty, box_size, east_position, total_units, cap_pct, box_round_pct, zero_box_round_pct=0.0, no_box_min_ea=5, has_sales_history=False, hq_qty=None, east_avg_daily=0.0, no_box_hq_min_days=10):
    whole_boxes = math.floor(raw_qty / box_size)
    remainder = raw_qty - whole_boxes * box_size
    remainder_pct = remainder / box_size

    if whole_boxes == 0 and raw_qty > 0:
        # Low priority: a less-than-a-box shipment isn't critical enough to
        # risk fragmenting HQ's own already-thin supply. Applies to every
        # less-than-a-box case below, not just the tiny (<no_box_min_ea EA)
        # one — if HQ can't spare at least no_box_hq_min_days of its own
        # runway (at the EAST demand rate) for this SKU, skip regardless of
        # sales history or box-rounding thresholds.
        if east_avg_daily > 0 and hq_qty is not None and (hq_qty / east_avg_daily) < no_box_hq_min_days:
            return 0.0, f"HQ has under {no_box_hq_min_days:g} days of its own supply left for this SKU — skipping this less-than-a-box shipment to preserve HQ stock"

        # Too small a loose pick to bother the warehouse with — the floor no
        # longer forces a shipment here (may leave EAST below the floor for
        # this specific SKU, which is intentional: better that than a steady
        # stream of awkward tiny picks). Sales history is still a real reason
        # to restock, so round up to a full box instead of skipping outright
        # — unless that would breach the cap, in which case skip after all.
        if raw_qty < no_box_min_ea:
            if has_sales_history:
                rounded_up = box_size
                if east_position + rounded_up > cap_pct * total_units + 1e-9:
                    return 0.0, f"sales history justifies restocking, but rounding up to 1 box of {box_size:g} would breach the {cap_pct:.0%} cap — skipped"
                return rounded_up, f"rounded up to 1 box of {box_size:g} — sales history justifies restocking despite raw demand under {no_box_min_ea:g} EA"
            return 0.0, f"raw demand ({raw_qty:g}) is under {no_box_min_ea:g} EA and under a full box, with no sales history — skipped"

        # The 0-vs-1-box boundary is a different decision from N-vs-(N+1): going
        # from 0 to 1 box is a 100% jump, so genuine (if small) unmet demand
        # below a full box shouldn't be silently zeroed out by the general
        # box_round_pct threshold, which is tuned for the N>=1 case. Use a
        # separate, lower bar here — below it, demand is negligible enough to
        # correctly skip; at or above it, ship the 1 box (unless that breaches
        # the cap, in which case skip rather than ship an awkward
        # non-box-aligned raw quantity — see the module-level note on why the
        # floor never blocks a round-down here).
        if remainder_pct >= zero_box_round_pct:
            rounded_up = box_size
            if east_position + rounded_up > cap_pct * total_units + 1e-9:
                return 0.0, f"rounding up to 1 box of {box_size:g} would breach the {cap_pct:.0%} cap — skipped instead of shipping a partial box"
            return rounded_up, f"rounded up to 1 box of {box_size:g} (demand below a full box but ≥{zero_box_round_pct:.0%} of one)"

    # Below here (N>=1 boxes, or the whole_boxes==0 fall-through when the
    # remainder wasn't even worth a 1-box round-up), rounding down is always
    # box-aligned AND always cap-safe by construction — shipping less can
    # never push EAST over a ceiling. The floor is deliberately not checked:
    # it's a soft target upstream (it can inflate raw_qty via min_floor_qty),
    # not a hard rule that gets to force a fractional shipment here. If a
    # round-down leaves a SKU under its floor this week, next week's run
    # re-evaluates it with fresh data — a recoverable, bounded cost, unlike
    # the cap (real overstock/spoilage risk) or a steady stream of loose,
    # damage-prone picks for the warehouse to hand-count.
    if remainder_pct < box_round_pct:
        rounded_down = whole_boxes * box_size
        return rounded_down, f"rounded down to {rounded_down / box_size:g} box(es) of {box_size:g}"
    rounded_up = (whole_boxes + 1) * box_size
    if east_position + rounded_up > cap_pct * total_units + 1e-9:
        rounded_down = whole_boxes * box_size
        return rounded_down, f"rounding up would breach the {cap_pct:.0%} cap — rounded down to {rounded_down / box_size:g} box(es) instead"
    return rounded_up, f"rounded up to {rounded_up / box_size:g} box(es) of {box_size:g}"


def decide_rounding_kimchi(raw_qty, box_size, east_position, total_units, hq_qty, floor_pct, cap_pct, hard_cap_pct):
    """Kimchi products always ship in whole boxes — never loose units — and
    default to rounding UP rather than the 30%-remainder threshold used
    elsewhere. Rounding up past cap_pct is tolerated as long as it stays
    under hard_cap_pct; at or beyond hard_cap_pct it rounds down instead,
    unless rounding down would breach floor_pct, in which case it reverts
    to rounding up regardless (floor protection wins).
    """
    if raw_qty <= 1e-9:
        return 0.0, "김치: no shipment needed"

    whole_boxes = math.floor(raw_qty / box_size)
    max_boxes_from_hq = math.floor(hq_qty / box_size) if hq_qty > 0 else 0
    rounded_up = min(whole_boxes + 1, max_boxes_from_hq) * box_size
    rounded_down = whole_boxes * box_size

    up_share = (east_position + rounded_up) / total_units if total_units else 0.0
    if up_share < cap_pct - 1e-9:
        return rounded_up, f"김치: rounded up to {rounded_up / box_size:g} box(es) of {box_size:g} (within {cap_pct:.0%} cap)"
    if up_share < hard_cap_pct - 1e-9:
        return rounded_up, f"김치: rounded up to {rounded_up / box_size:g} box(es) — over {cap_pct:.0%} cap but under {hard_cap_pct:.0%}, kept"

    down_share = (east_position + rounded_down) / total_units if total_units else 0.0
    if down_share < floor_pct - 1e-9:
        return rounded_up, f"김치: rounding down would breach the {floor_pct:.0%} floor — kept rounded up at {rounded_up / box_size:g} box(es)"
    return rounded_down, f"김치: rounded up hit {up_share:.0%} (≥{hard_cap_pct:.0%}) — rounded down to {rounded_down / box_size:g} box(es)"


def compute_shipment(hq_qty, east_position, total_units, east_avg_daily, total_avg_daily, box_size, settings, name="", gr_few=False, status_online="", days_since_last_sale=None, storage=""):
    """The settings-dependent half of the algorithm — everything from here
    depends only on settings plus a handful of already-derived numbers
    (hq_qty, east_position, total_units, east_avg_daily, total_avg_daily,
    box_size). Kept separate from compute_recommendations so a run's items
    can be re-scored against new settings without re-reading the workbook —
    used when the review page's live settings panel changes something and
    the change is persisted on save/finalize.
    """
    settings = _effective_settings_for_storage(settings, storage)
    target_days = settings["target_days"]
    box_round_pct = settings["box_round_pct"]
    zero_box_round_pct = settings.get("zero_box_round_pct", 0.0)
    no_box_min_ea = settings.get("no_box_min_ea", 5)
    no_box_hq_min_days = settings.get("no_box_hq_min_days", 10)
    no_sales_history = total_avg_daily <= 0

    kimchi_enabled = settings.get("kimchi_override_enabled", True)
    kimchi_keyword = settings.get("kimchi_keyword", "김치")
    is_kimchi = bool(kimchi_enabled and kimchi_keyword and kimchi_keyword in (name or ""))

    # GR_Few is a manual, per-SKU override and takes priority over the
    # automatic 김치 keyword match if both apply. Its cap and hard-cap are
    # the same value (15%) — decide_rounding_kimchi's "over cap but under
    # hard cap" grace band collapses to nothing, so rounding up is only
    # kept when it doesn't exceed 15% at all.
    use_box_level_override = gr_few or is_kimchi
    if gr_few:
        floor_pct = 0.0
        cap_pct = 0.15
        hard_cap_pct = 0.15
    elif is_kimchi:
        cap_pct = settings["kimchi_cap_pct"]
        floor_pct = settings["kimchi_floor_pct"]
        hard_cap_pct = settings.get("kimchi_hard_cap_pct", 0.20)
    else:
        cap_pct = settings["cap_pct"]
        floor_pct = settings["floor_pct"]

    desired_qty = max(0.0, target_days * east_avg_daily - east_position)
    min_floor_qty = max(0.0, floor_pct * total_units - east_position)
    target_qty = max(desired_qty, min_floor_qty)
    cap_room = cap_pct * total_units - east_position
    raw_qty = max(0.0, min(target_qty, cap_room, hq_qty))
    binding = _binding_constraint(target_qty, cap_room, hq_qty, desired_qty, min_floor_qty)

    if box_size and use_box_level_override:
        final_qty, rounding_note = decide_rounding_kimchi(raw_qty, box_size, east_position, total_units, hq_qty, floor_pct, cap_pct, hard_cap_pct)
    elif box_size:
        final_qty, rounding_note = decide_rounding(raw_qty, box_size, east_position, total_units, cap_pct, box_round_pct, zero_box_round_pct, no_box_min_ea, not no_sales_history, hq_qty, east_avg_daily, no_box_hq_min_days)
    else:
        final_qty = raw_qty
        rounding_note = "no box size on file — units only"
    final_qty = int(math.floor(final_qty + 0.5))  # round-half-up, to match the JS client's Math.round

    flags = []
    if gr_few:
        flags.append("GR_FEW_OVERRIDE")
    elif is_kimchi:
        flags.append("KIMCHI_OVERRIDE")
    if no_sales_history:
        flags.append("NO_SALES_HISTORY")
    if final_qty > 0:
        stale_threshold = settings.get("stale_sale_days_threshold", 45)
        is_active_status = str(status_online or "").strip().lower() == "active"
        is_stale_sale = days_since_last_sale is not None and days_since_last_sale >= stale_threshold
        if not is_active_status or is_stale_sale:
            flags.append("POSSIBLY_DISCONTINUED")
    if min_floor_qty > desired_qty + 1e-9:
        flags.append("MINIMUM_FLOOR_APPLIED")
    if final_qty == 0 and raw_qty > 0 and box_size and not use_box_level_override and raw_qty < box_size:
        flags.append("SMALL_QTY_SKIPPED")
    if hq_qty <= 0:
        flags.append("HQ_OUT_OF_STOCK")
    elif binding == "HQ_STOCK" and hq_qty < min_floor_qty - 1e-9:
        flags.append("HQ_SHORTAGE_BELOW_MINIMUM_FLOOR")
    if east_avg_daily > 0:
        post_east_days = (east_position + final_qty) / east_avg_daily
        if binding in ("CAP_40", "HQ_STOCK") and post_east_days < target_days - 1e-9:
            flags.append("EAST_UNDERSUPPLIED")
        post_west_days = (hq_qty - final_qty) / east_avg_daily
        if post_west_days < target_days - 1e-9:
            flags.append("WEST_UNDERSUPPLIED")

    return {
        "desired_qty": desired_qty, "min_floor_qty": min_floor_qty, "target_qty": target_qty,
        "cap_room": cap_room, "raw_qty": raw_qty, "binding_constraint": binding,
        "rounding_note": rounding_note, "final_qty_computed": final_qty, "flags": flags,
        "included_default": final_qty > 0,
    }


def _resolve_cbm_ea(row, box_size, has_col):
    """CBM(EA) fallback chain, in order of directness: the column itself,
    then unit-level dimensions (already EA-level, no box_size needed), then
    CBM(CTN) or carton dimensions divided down by box_size, then a small
    nominal default so a SKU with no CBM data at all still counts toward
    pallet-total estimates instead of being silently excluded.
    """
    az = float(row[COL_CBM_EA]) if row[COL_CBM_EA] and row[COL_CBM_EA] > 0 else None
    if az:
        return az

    if has_col[COL_UNIT_LENGTH_MM] and has_col[COL_UNIT_WIDTH_MM] and has_col[COL_UNIT_HEIGHT_MM]:
        ul, uw, uh = row[COL_UNIT_LENGTH_MM], row[COL_UNIT_WIDTH_MM], row[COL_UNIT_HEIGHT_MM]
        if ul > 0 and uw > 0 and uh > 0:
            return (ul * uw * uh) / MM3_PER_CBM

    if has_col[COL_CBM_CTN] and box_size:
        cbm_ctn = row[COL_CBM_CTN]
        if cbm_ctn > 0:
            return cbm_ctn / box_size

    if (has_col[COL_CTN_LENGTH_MM] and has_col[COL_CTN_WIDTH_MM] and has_col[COL_CTN_HEIGHT_MM] and box_size):
        cl, cw, ch = row[COL_CTN_LENGTH_MM], row[COL_CTN_WIDTH_MM], row[COL_CTN_HEIGHT_MM]
        if cl > 0 and cw > 0 and ch > 0:
            return ((cl * cw * ch) / MM3_PER_CBM) / box_size

    return CBM_EA_NOMINAL_DEFAULT


def _resolve_cs_per_plt(cs_per_plt, box_size, cbm_ea):
    """CS/PLT (boxes per pallet) fallback: the real value is authoritative
    for pallet estimates whenever present. When blank, estimate an
    equivalent boxes-per-pallet from this SKU's (possibly also-estimated)
    CBM(EA); only fall back to the flat pallet-capacity assumption when
    box_size itself is missing too (so per-box CBM can't be derived either).
    """
    if cs_per_plt and cs_per_plt > 0:
        return cs_per_plt
    if box_size and cbm_ea:
        cbm_per_box = box_size * cbm_ea
        if cbm_per_box > 0:
            return CBM_PER_PALLET / cbm_per_box
    return BOXES_PER_PALLET


def compute_recommendations(boxhero_df, scm_sales_df, settings=None, gr_few_skus=None):
    """Returns a list of dicts, one per SKU in boxhero, with the full
    calculation breakdown needed for both the review UI and the detailed
    export. gr_few_skus is the standing set of SKUs a user has previously
    marked GR_Few — new runs default those SKUs' checkbox to checked.
    """
    s = dict(DEFAULT_SETTINGS)
    if settings:
        s.update(settings)
    gr_few_skus = gr_few_skus or set()

    bh = boxhero_df.copy()
    bh[COL_SKU] = bh[COL_SKU].astype(str).str.strip()
    for col in (COL_HQ_ONLINE, COL_LOCAL_TRANS_ONLINE, COL_KPAC_ONLINE,
                COL_PA_ART, COL_PA_ONLINE, COL_PA_1_PRE, COL_PA_2_PRE,
                COL_PA_1_AIR_PRE, COL_PA_2_AIR_PRE, COL_BOX_SIZE,
                COL_COST, COL_CS_PER_PLT, COL_CBM_EA):
        bh[col] = _clean_numeric(bh[col])
    has_cbm_fallback_col = {c: c in bh.columns for c in OPTIONAL_CBM_FALLBACK_COLS}
    for col, present in has_cbm_fallback_col.items():
        if present:
            bh[col] = _clean_numeric(bh[col])

    scm = scm_sales_df.copy()
    scm[SCM_COL_SKU] = scm[SCM_COL_SKU].astype(str).str.strip()
    for col in (SCM_COL_5D_AVG, SCM_COL_30D_AVG, SCM_COL_90D_AVG,
                SCM_COL_5D_EAST, SCM_COL_30D_EAST, SCM_COL_90D_EAST,
                SCM_COL_5D_WEST, SCM_COL_30D_WEST, SCM_COL_90D_WEST):
        scm[col] = _clean_numeric(scm[col])
    scm[SCM_COL_LAST_SALE_DATE] = pd.to_datetime(scm[SCM_COL_LAST_SALE_DATE], errors="coerce")
    scm[SCM_COL_REFRESHED_AT] = pd.to_datetime(scm[SCM_COL_REFRESHED_AT], errors="coerce")
    # Anchor "days since last sale" to the data's own sync timestamp rather
    # than wall-clock now, so the diagnostic stays stable no matter when the
    # export is opened.
    as_of_date = scm[SCM_COL_REFRESHED_AT].max()
    # If a SKU appears more than once in scm_sales, keep the most recent-looking
    # (last) row rather than silently summing/duplicating.
    scm = scm.drop_duplicates(subset=[SCM_COL_SKU], keep="last").set_index(SCM_COL_SKU)

    cap_pct = s["cap_pct"]
    floor_pct = s["floor_pct"]
    target_days = s["target_days"]
    box_round_pct = s["box_round_pct"]

    results = []
    for _, row in bh.iterrows():
        sku = row[COL_SKU]

        hq_qty = float(row[COL_HQ_ONLINE] + row[COL_LOCAL_TRANS_ONLINE] + row[COL_KPAC_ONLINE])
        east_onhand = float(row[COL_PA_ART] + row[COL_PA_ONLINE])
        pa1 = float(row[COL_PA_1_PRE])
        pa2 = float(row[COL_PA_2_PRE])
        pa1_air = float(row[COL_PA_1_AIR_PRE])
        pa2_air = float(row[COL_PA_2_AIR_PRE])
        # A SKU is assumed to be genuinely in transit via only ONE of the 4
        # staging areas (regular or air, PA_1 or PA_2) at a time — whichever
        # is largest; nonzero values in the other 3 are stale leftover data
        # BoxHero hasn't cleared yet, same assumption as the original 2-value
        # (non-air) version of this calculation.
        pre_storage_values = [pa1, pa2, pa1_air, pa2_air]
        in_transit = max(pre_storage_values)
        in_transit_ignored = sum(pre_storage_values) - in_transit
        total_units = hq_qty + east_onhand + in_transit
        east_position = east_onhand + in_transit

        sales_row = scm.loc[sku] if sku in scm.index else None
        if sales_row is not None:
            avg5 = float(sales_row[SCM_COL_5D_AVG])
            avg30 = float(sales_row[SCM_COL_30D_AVG])
            avg90 = float(sales_row[SCM_COL_90D_AVG])
            windows = {"5d": avg5, "30d": avg30, "90d": avg90}
            window_used = max(windows, key=windows.get)
            total_avg_daily = windows[window_used]
            east_qty_by_window = {
                "5d": float(sales_row[SCM_COL_5D_EAST]),
                "30d": float(sales_row[SCM_COL_30D_EAST]),
                "90d": float(sales_row[SCM_COL_90D_EAST]),
            }
            west_qty_by_window = {
                "5d": float(sales_row[SCM_COL_5D_WEST]),
                "30d": float(sales_row[SCM_COL_30D_WEST]),
                "90d": float(sales_row[SCM_COL_90D_WEST]),
            }
            # scm_sales' avg_daily_qty columns use an internal (selling-days)
            # denominator we can't reproduce directly, so rather than divide
            # east_qty by a fixed calendar window, split the already-correct
            # total_avg_daily by EAST's real observed share of that window's
            # raw units (east_qty always sums exactly to total_qty per window).
            east_q = east_qty_by_window[window_used]
            west_q = west_qty_by_window[window_used]
            east_share = east_q / (east_q + west_q) if (east_q + west_q) > 0 else 0.5
            east_avg_daily = total_avg_daily * east_share
            last_sale_date = sales_row[SCM_COL_LAST_SALE_DATE]
            days_since_last_sale = (
                (as_of_date - last_sale_date).days
                if pd.notna(last_sale_date) and pd.notna(as_of_date) else None
            )
        else:
            avg5 = avg30 = avg90 = 0.0
            window_used = None
            total_avg_daily = 0.0
            east_avg_daily = 0.0
            days_since_last_sale = None

        box_size = float(row[COL_BOX_SIZE]) if row[COL_BOX_SIZE] and row[COL_BOX_SIZE] > 0 else None
        cost = float(row[COL_COST]) if row[COL_COST] and row[COL_COST] > 0 else None
        cbm_ea = _resolve_cbm_ea(row, box_size, has_cbm_fallback_col)
        raw_cs_per_plt = float(row[COL_CS_PER_PLT]) if row[COL_CS_PER_PLT] and row[COL_CS_PER_PLT] > 0 else None
        cs_per_plt = _resolve_cs_per_plt(raw_cs_per_plt, box_size, cbm_ea)
        name = str(row[COL_NAME]) if pd.notna(row[COL_NAME]) else ""
        status_online = str(row[COL_STATUS_ONLINE]) if pd.notna(row[COL_STATUS_ONLINE]) else ""
        storage = str(row[COL_STORAGE]).strip() if pd.notna(row[COL_STORAGE]) else ""
        gr_few = sku in gr_few_skus

        shipment = compute_shipment(hq_qty, east_position, total_units, east_avg_daily, total_avg_daily, box_size, s, name, gr_few, status_online, days_since_last_sale, storage)

        results.append({
            "sku": sku,
            "gr_few": gr_few,
            "days_since_last_sale": days_since_last_sale,
            "barcode": str(row[COL_BARCODE]) if pd.notna(row[COL_BARCODE]) else "",
            "name": name,
            "english_name": str(row[COL_ENGLISH_NAME]) if pd.notna(row[COL_ENGLISH_NAME]) else "",
            "category": str(row[COL_CATEGORY]) if pd.notna(row[COL_CATEGORY]) else "",
            "status_online": status_online,
            "importance": str(row[COL_IMPORTANCE]).strip() if pd.notna(row[COL_IMPORTANCE]) and str(row[COL_IMPORTANCE]).strip() else "UNKNOWN",
            "storage": storage,
            "hq_online": float(row[COL_HQ_ONLINE]),
            "local_trans_online": float(row[COL_LOCAL_TRANS_ONLINE]),
            "kpac_online": float(row[COL_KPAC_ONLINE]),
            "hq_qty": hq_qty,
            "pa_art": float(row[COL_PA_ART]),
            "pa_online": float(row[COL_PA_ONLINE]),
            "east_onhand": east_onhand,
            "pa_1_pre": pa1,
            "pa_2_pre": pa2,
            "pa_1_air_pre": pa1_air,
            "pa_2_air_pre": pa2_air,
            "in_transit": in_transit,
            "in_transit_ignored": in_transit_ignored,
            "total_units": total_units,
            "east_position": east_position,
            "avg5": avg5,
            "avg30": avg30,
            "avg90": avg90,
            "window_used": window_used,
            "total_avg_daily": total_avg_daily,
            "east_avg_daily": east_avg_daily,
            "desired_qty": shipment["desired_qty"],
            "min_floor_qty": shipment["min_floor_qty"],
            "target_qty": shipment["target_qty"],
            "cap_room": shipment["cap_room"],
            "raw_qty": shipment["raw_qty"],
            "binding_constraint": shipment["binding_constraint"],
            "box_size": box_size,
            "cost": cost,
            "cs_per_plt": cs_per_plt,
            "cbm_ea": cbm_ea,
            "rounding_note": shipment["rounding_note"],
            "final_qty_computed": shipment["final_qty_computed"],
            "flags": shipment["flags"],
            "included_default": shipment["included_default"],
        })

    return results


def est_boxes(qty, box_size):
    return qty / box_size if box_size else None


def est_pallets(qty, box_size):
    return qty / box_size / BOXES_PER_PALLET if box_size else None


def days_after_ship(hq_qty, east_position, east_avg_daily, ship_qty):
    """Estimated days-of-supply remaining at HQ and EAST after shipping
    `ship_qty` units, given the (possibly live-edited) quantity. Purely a
    display derivation — never persisted or fed back into the algorithm."""
    if not east_avg_daily or east_avg_daily <= 0:
        return None, None
    hq_days = (hq_qty - ship_qty) / east_avg_daily
    east_days = (east_position + ship_qty) / east_avg_daily
    return hq_days, east_days


def kpac_hq_split(qty, box_size, kpac_online):
    """KPAC is a physically separate warehouse from the rest of HQ WEST and
    only pulls/ships full boxes, never loose units. Given the quantity to
    ship, work out how many boxes should be pulled from KPAC vs. the rest of
    HQ, and how many loose units (always non-KPAC) fill out the remainder.

    KPAC is prioritized first (up to however many whole boxes of this SKU it
    actually holds); the rest of the box-level need falls back to HQ, and any
    leftover that doesn't make a full box is pulled as HQ units.
    """
    if not box_size:
        return 0, 0, qty
    boxes_needed = math.floor(qty / box_size)
    remainder_units = qty - boxes_needed * box_size
    kpac_available_boxes = math.floor((kpac_online or 0) / box_size)
    kpac_boxes = min(boxes_needed, kpac_available_boxes)
    hq_boxes = boxes_needed - kpac_boxes
    return kpac_boxes, hq_boxes, remainder_units
