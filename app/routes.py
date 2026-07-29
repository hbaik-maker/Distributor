import json
import os
from datetime import datetime

from flask import (
    Blueprint, current_app, flash, redirect, render_template, request,
    send_file, url_for,
)
from werkzeug.utils import secure_filename

from . import calc
from .export import build_detailed_workbook, build_simple_workbook, workbook_to_bytes
from .models import GrFewSku, Run, RunItem, Settings, db
from .timeutil import to_pacific

bp = Blueprint("main", __name__)

ALLOWED_EXTENSIONS = {".xlsx", ".xlsm"}


def _get_settings_dict():
    s = Settings.query.first()
    return s.as_dict()


@bp.route("/")
def index():
    pending = Run.query.filter_by(status="pending").order_by(Run.created_at.desc()).all()
    recent = Run.query.filter_by(status="finalized").order_by(Run.created_at.desc()).limit(10).all()
    return render_template("index.html", pending=pending, recent=recent)


@bp.route("/upload", methods=["POST"])
def upload():
    file = request.files.get("datasource")
    if not file or file.filename == "":
        flash("Please choose an Excel file to upload.", "error")
        return redirect(url_for("main.index"))

    filename = secure_filename(file.filename)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        flash("File must be an .xlsx (or .xlsm) workbook.", "error")
        return redirect(url_for("main.index"))

    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    stored_name = f"{timestamp}_{filename}"
    stored_path = os.path.join(current_app.config["UPLOAD_FOLDER"], stored_name)
    file.save(stored_path)

    try:
        boxhero_df, scm_df = calc.load_workbook_frames(stored_path)
        settings = _get_settings_dict()
        gr_few_skus = {row.sku for row in GrFewSku.query.all()}
        recs = calc.compute_recommendations(boxhero_df, scm_df, settings, gr_few_skus)
    except calc.DataValidationError as exc:
        flash(f"Could not process this file: {exc}", "error")
        return redirect(url_for("main.index"))
    except Exception as exc:  # noqa: BLE001 - surface unexpected parse errors to the user
        flash(f"Unexpected error while processing the file: {exc}", "error")
        return redirect(url_for("main.index"))

    run = Run(
        source_filename=filename,
        status="pending",
        settings_json=json.dumps(settings),
    )
    db.session.add(run)
    db.session.flush()

    for r in recs:
        db.session.add(RunItem(
            run_id=run.id,
            sku=r["sku"], barcode=r["barcode"], name=r["name"],
            english_name=r["english_name"], category=r["category"],
            status_online=r["status_online"], importance=r["importance"], storage=r["storage"],
            hq_online=r["hq_online"], local_trans_online=r["local_trans_online"],
            kpac_online=r["kpac_online"], hq_qty=r["hq_qty"],
            pa_art=r["pa_art"], pa_online=r["pa_online"], east_onhand=r["east_onhand"],
            pa_1_pre=r["pa_1_pre"], pa_2_pre=r["pa_2_pre"],
            in_transit=r["in_transit"], in_transit_ignored=r["in_transit_ignored"],
            total_units=r["total_units"], east_position=r["east_position"],
            avg5=r["avg5"], avg30=r["avg30"], avg90=r["avg90"],
            window_used=r["window_used"], total_avg_daily=r["total_avg_daily"],
            east_avg_daily=r["east_avg_daily"], days_since_last_sale=r["days_since_last_sale"],
            desired_qty=r["desired_qty"],
            min_floor_qty=r["min_floor_qty"], target_qty=r["target_qty"],
            cap_room=r["cap_room"], raw_qty=r["raw_qty"],
            binding_constraint=r["binding_constraint"], box_size=r["box_size"],
            rounding_note=r["rounding_note"], final_qty_computed=r["final_qty_computed"],
            flags_json=json.dumps(r["flags"]),
            included=r["included_default"], final_qty_user=None,
            gr_few=r["gr_few"],
        ))
    db.session.commit()

    flash(f"Loaded {len(recs)} SKUs from {filename}. Review the recommendation below.", "success")
    return redirect(url_for("main.review", run_id=run.id))


@bp.route("/runs")
def run_list():
    runs = Run.query.order_by(Run.created_at.desc()).all()
    return render_template("history.html", runs=runs)


@bp.route("/runs/<int:run_id>")
def run_detail(run_id):
    run = Run.query.get_or_404(run_id)
    items = run.items
    included_items = [it for it in items if it.included]
    summary = {
        "total_skus": len(items),
        "included_skus": len(included_items),
        "total_units_to_ship": sum(it.effective_qty() for it in included_items),
        "flagged_skus": sum(1 for it in items if it.flags()),
    }
    return render_template("run_detail.html", run=run, summary=summary)


@bp.route("/runs/<int:run_id>/review")
def review(run_id):
    run = Run.query.get_or_404(run_id)
    return render_template(
        "review.html", run=run,
        importance_grades=calc.IMPORTANCE_GRADES, storage_types=calc.STORAGE_TYPES,
    )


def _apply_live_settings(run):
    """The review page's inline settings panel (cap/floor/target days/box
    round) recalculates client-side with no server round-trip, purely for
    instant feedback. If the submitted values differ from what's stored,
    persist them and re-score every item's diagnostic fields against the
    new settings — otherwise final_qty_computed and the Detailed export's
    reasoning columns would go stale relative to what's actually shipping.
    """
    cap_pct = request.form.get("live_cap_pct", type=float)
    floor_pct = request.form.get("live_floor_pct", type=float)
    target_days = request.form.get("live_target_days", type=float)
    box_round_pct = request.form.get("live_box_round_pct", type=float)
    zero_box_round_pct = request.form.get("live_zero_box_round_pct", type=float)
    stale_sale_days_threshold = request.form.get("live_stale_sale_days_threshold", type=float)
    kimchi_floor_pct = request.form.get("live_kimchi_floor_pct", type=float)
    kimchi_cap_pct = request.form.get("live_kimchi_cap_pct", type=float)
    kimchi_hard_cap_pct = request.form.get("live_kimchi_hard_cap_pct", type=float)
    kimchi_keyword = request.form.get("live_kimchi_keyword", type=str)
    if None in (cap_pct, floor_pct, target_days, box_round_pct, zero_box_round_pct, stale_sale_days_threshold,
                kimchi_floor_pct, kimchi_cap_pct, kimchi_hard_cap_pct, kimchi_keyword):
        return
    # Merge over the run's existing settings rather than replacing wholesale,
    # so any setting not present in the live panel carries forward instead of
    # silently resetting to its hardcoded default the next time any live
    # field changes.
    new_settings = dict(run.settings())
    new_settings.update({
        "cap_pct": cap_pct / 100.0, "floor_pct": floor_pct / 100.0,
        "target_days": int(target_days), "box_round_pct": box_round_pct / 100.0,
        "zero_box_round_pct": zero_box_round_pct / 100.0,
        "stale_sale_days_threshold": int(stale_sale_days_threshold),
        "kimchi_override_enabled": request.form.get("live_kimchi_enabled") is not None,
        "kimchi_keyword": kimchi_keyword.strip() or "김치",
        "kimchi_floor_pct": kimchi_floor_pct / 100.0,
        "kimchi_cap_pct": kimchi_cap_pct / 100.0,
        "kimchi_hard_cap_pct": kimchi_hard_cap_pct / 100.0,
    })
    if new_settings == run.settings():
        return
    run.settings_json = json.dumps(new_settings)
    for item in run.items:
        shipment = calc.compute_shipment(
            item.hq_qty, item.east_position, item.total_units,
            item.east_avg_daily, item.total_avg_daily, item.box_size,
            new_settings, item.name, item.gr_few,
            item.status_online, item.days_since_last_sale,
        )
        item.desired_qty = shipment["desired_qty"]
        item.min_floor_qty = shipment["min_floor_qty"]
        item.target_qty = shipment["target_qty"]
        item.cap_room = shipment["cap_room"]
        item.raw_qty = shipment["raw_qty"]
        item.binding_constraint = shipment["binding_constraint"]
        item.rounding_note = shipment["rounding_note"]
        item.final_qty_computed = shipment["final_qty_computed"]
        item.flags_json = json.dumps(shipment["flags"])


def _apply_form_to_items(run):
    _apply_live_settings(run)
    settings = run.settings()
    gr_few_registry = {row.sku: row for row in GrFewSku.query.all()}
    for item in run.items:
        included = request.form.get(f"included_{item.id}") is not None
        gr_few = request.form.get(f"grfew_{item.id}") is not None
        qty_raw = request.form.get(f"qty_{item.id}", "").strip()
        item.included = included

        if gr_few != item.gr_few:
            item.gr_few = gr_few
            # GR_Few is memorized across future runs, independent of this
            # run — add/remove the SKU from the standing registry so the
            # next upload defaults this checkbox to match.
            existing = gr_few_registry.get(item.sku)
            if gr_few and not existing:
                new_entry = GrFewSku(sku=item.sku)
                db.session.add(new_entry)
                gr_few_registry[item.sku] = new_entry
            elif not gr_few and existing:
                db.session.delete(existing)
                del gr_few_registry[item.sku]

            shipment = calc.compute_shipment(
                item.hq_qty, item.east_position, item.total_units,
                item.east_avg_daily, item.total_avg_daily, item.box_size,
                settings, item.name, item.gr_few,
                item.status_online, item.days_since_last_sale,
            )
            item.desired_qty = shipment["desired_qty"]
            item.min_floor_qty = shipment["min_floor_qty"]
            item.target_qty = shipment["target_qty"]
            item.cap_room = shipment["cap_room"]
            item.raw_qty = shipment["raw_qty"]
            item.binding_constraint = shipment["binding_constraint"]
            item.rounding_note = shipment["rounding_note"]
            item.final_qty_computed = shipment["final_qty_computed"]
            item.flags_json = json.dumps(shipment["flags"])

        if qty_raw == "":
            item.final_qty_user = None
        else:
            try:
                qty_val = int(float(qty_raw))
            except ValueError:
                qty_val = item.final_qty_computed
            item.final_qty_user = None if qty_val == item.final_qty_computed else max(0, qty_val)

        # The pallet-cap "Apply pallet caps" review action can flag a SKU as
        # under-supplied client-side; mirror that toggle into the persisted
        # flags so it survives into Save/Finalize and shows up in exports.
        cap_flag = request.form.get(f"capflag_{item.id}", "").strip()
        flags = item.flags()
        if cap_flag == "PALLET_CAP_UNDERSUPPLIED" and cap_flag not in flags:
            flags.append(cap_flag)
            item.flags_json = json.dumps(flags)
        elif cap_flag == "" and "PALLET_CAP_UNDERSUPPLIED" in flags:
            flags.remove("PALLET_CAP_UNDERSUPPLIED")
            item.flags_json = json.dumps(flags)


@bp.route("/runs/<int:run_id>/review", methods=["POST"])
def save_review(run_id):
    run = Run.query.get_or_404(run_id)
    if run.status != "pending":
        flash("This run is already finalized and can no longer be edited.", "error")
        return redirect(url_for("main.run_detail", run_id=run.id))
    _apply_form_to_items(run)
    db.session.commit()
    flash("Progress saved.", "success")
    return redirect(url_for("main.review", run_id=run.id))


@bp.route("/runs/<int:run_id>/finalize", methods=["POST"])
def finalize(run_id):
    run = Run.query.get_or_404(run_id)
    if run.status != "pending":
        return redirect(url_for("main.run_detail", run_id=run.id))
    _apply_form_to_items(run)
    run.status = "finalized"
    run.finalized_at = datetime.utcnow()
    db.session.commit()
    flash("Run finalized and saved to history.", "success")
    return redirect(url_for("main.run_detail", run_id=run.id))


@bp.route("/runs/<int:run_id>/export/simple")
def export_simple(run_id):
    run = Run.query.get_or_404(run_id)
    wb = build_simple_workbook(run)
    buf = workbook_to_bytes(wb)
    fname = f"east_shipment_simple_run{run.id}_{to_pacific(run.created_at).strftime('%Y%m%d')}.xlsx"
    return send_file(buf, as_attachment=True, download_name=fname,
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/runs/<int:run_id>/export/detailed")
def export_detailed(run_id):
    run = Run.query.get_or_404(run_id)
    wb = build_detailed_workbook(run)
    buf = workbook_to_bytes(wb)
    fname = f"east_shipment_detailed_run{run.id}_{to_pacific(run.created_at).strftime('%Y%m%d')}.xlsx"
    return send_file(buf, as_attachment=True, download_name=fname,
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/settings", methods=["GET", "POST"])
def settings_view():
    s = Settings.query.first()
    if request.method == "POST":
        try:
            s.cap_pct = float(request.form["cap_pct"]) / 100.0
            s.floor_pct = float(request.form["floor_pct"]) / 100.0
            s.target_days = int(request.form["target_days"])
            s.box_round_pct = float(request.form["box_round_pct"]) / 100.0
            s.zero_box_round_pct = float(request.form["zero_box_round_pct"]) / 100.0
            if not (0 < s.floor_pct < s.cap_pct <= 1):
                raise ValueError("Floor % must be less than Cap %, and Cap % must be <= 100.")
            if not (0 <= s.zero_box_round_pct <= s.box_round_pct):
                raise ValueError("Zero-box threshold % must be between 0 and the box rounding threshold %.")

            s.kimchi_override_enabled = "kimchi_override_enabled" in request.form
            s.kimchi_keyword = request.form.get("kimchi_keyword", "").strip() or "김치"
            s.kimchi_floor_pct = float(request.form["kimchi_floor_pct"]) / 100.0
            s.kimchi_cap_pct = float(request.form["kimchi_cap_pct"]) / 100.0
            s.kimchi_hard_cap_pct = float(request.form["kimchi_hard_cap_pct"]) / 100.0
            if not (0 < s.kimchi_floor_pct < s.kimchi_cap_pct < s.kimchi_hard_cap_pct <= 1):
                raise ValueError("Kimchi floor % must be less than cap %, which must be less than hard cap %, all <= 100.")

            s.stale_sale_days_threshold = int(request.form["stale_sale_days_threshold"])
            if s.stale_sale_days_threshold < 1:
                raise ValueError("Stale sale threshold must be at least 1 day.")
            db.session.commit()
            flash("Settings updated. They will apply to new runs only.", "success")
        except (KeyError, ValueError) as exc:
            db.session.rollback()
            flash(f"Invalid settings: {exc}", "error")
        return redirect(url_for("main.settings_view"))
    return render_template("settings.html", s=s)
