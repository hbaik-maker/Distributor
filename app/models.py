import json
from datetime import datetime

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class Settings(db.Model):
    __tablename__ = "settings"
    id = db.Column(db.Integer, primary_key=True)
    cap_pct = db.Column(db.Float, nullable=False, default=0.40)
    floor_pct = db.Column(db.Float, nullable=False, default=0.25)
    target_days = db.Column(db.Integer, nullable=False, default=21)
    box_round_pct = db.Column(db.Float, nullable=False, default=0.30)
    zero_box_round_pct = db.Column(db.Float, nullable=False, default=0.05)
    kimchi_override_enabled = db.Column(db.Boolean, nullable=False, default=True)
    kimchi_keyword = db.Column(db.String(64), nullable=False, default="김치")
    kimchi_floor_pct = db.Column(db.Float, nullable=False, default=0.10)
    kimchi_cap_pct = db.Column(db.Float, nullable=False, default=0.15)
    kimchi_hard_cap_pct = db.Column(db.Float, nullable=False, default=0.20)
    stale_sale_days_threshold = db.Column(db.Integer, nullable=False, default=45)

    def as_dict(self):
        return {
            "cap_pct": self.cap_pct,
            "floor_pct": self.floor_pct,
            "target_days": self.target_days,
            "box_round_pct": self.box_round_pct,
            "zero_box_round_pct": self.zero_box_round_pct,
            "kimchi_override_enabled": self.kimchi_override_enabled,
            "kimchi_keyword": self.kimchi_keyword,
            "kimchi_floor_pct": self.kimchi_floor_pct,
            "kimchi_cap_pct": self.kimchi_cap_pct,
            "kimchi_hard_cap_pct": self.kimchi_hard_cap_pct,
            "stale_sale_days_threshold": self.stale_sale_days_threshold,
        }


class GrFewSku(db.Model):
    """Standing registry of SKUs a user has marked GR_Few (0%-15% EAST
    allocation — cheaper to ship straight from West than pay combined LTL
    transfer + East outbound costs). Independent of any single run: new
    uploads default a SKU's GR_Few checkbox to checked if it's in here, and
    checking/unchecking on the review page updates this table on save so
    the choice carries forward to future runs.
    """
    __tablename__ = "gr_few_skus"
    id = db.Column(db.Integer, primary_key=True)
    sku = db.Column(db.String(64), unique=True, nullable=False)


class Run(db.Model):
    __tablename__ = "runs"
    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    source_filename = db.Column(db.String(255), nullable=False)
    status = db.Column(db.String(20), nullable=False, default="pending")  # pending | finalized
    settings_json = db.Column(db.Text, nullable=False, default="{}")
    finalized_at = db.Column(db.DateTime, nullable=True)

    items = db.relationship(
        "RunItem", backref="run", cascade="all, delete-orphan", order_by="RunItem.sku"
    )

    def settings(self):
        # Merge over DEFAULT_SETTINGS so runs created before a new setting
        # was added (e.g. the 김치 override) still get a usable default
        # instead of a missing key.
        from . import calc
        merged = dict(calc.DEFAULT_SETTINGS)
        merged.update(json.loads(self.settings_json))
        return merged


class RunItem(db.Model):
    __tablename__ = "run_items"
    id = db.Column(db.Integer, primary_key=True)
    run_id = db.Column(db.Integer, db.ForeignKey("runs.id"), nullable=False)

    sku = db.Column(db.String(64), nullable=False)
    barcode = db.Column(db.String(64))
    name = db.Column(db.String(255))
    english_name = db.Column(db.String(255))
    category = db.Column(db.String(128))
    status_online = db.Column(db.String(32))
    importance = db.Column(db.String(8))
    storage = db.Column(db.String(8))

    hq_online = db.Column(db.Float, default=0)
    local_trans_online = db.Column(db.Float, default=0)
    kpac_online = db.Column(db.Float, default=0)
    hq_qty = db.Column(db.Float, default=0)

    pa_art = db.Column(db.Float, default=0)
    pa_online = db.Column(db.Float, default=0)
    east_onhand = db.Column(db.Float, default=0)

    pa_1_pre = db.Column(db.Float, default=0)
    pa_2_pre = db.Column(db.Float, default=0)
    in_transit = db.Column(db.Float, default=0)
    in_transit_ignored = db.Column(db.Float, default=0)

    total_units = db.Column(db.Float, default=0)
    east_position = db.Column(db.Float, default=0)

    avg5 = db.Column(db.Float, default=0)
    avg30 = db.Column(db.Float, default=0)
    avg90 = db.Column(db.Float, default=0)
    window_used = db.Column(db.String(8))
    total_avg_daily = db.Column(db.Float, default=0)
    east_avg_daily = db.Column(db.Float, default=0)
    days_since_last_sale = db.Column(db.Integer, nullable=True)

    desired_qty = db.Column(db.Float, default=0)
    min_floor_qty = db.Column(db.Float, default=0)
    target_qty = db.Column(db.Float, default=0)
    cap_room = db.Column(db.Float, default=0)
    raw_qty = db.Column(db.Float, default=0)
    binding_constraint = db.Column(db.String(16))

    box_size = db.Column(db.Float, nullable=True)
    rounding_note = db.Column(db.String(255))

    final_qty_computed = db.Column(db.Integer, default=0)
    flags_json = db.Column(db.Text, default="[]")

    included = db.Column(db.Boolean, default=False)
    final_qty_user = db.Column(db.Integer, nullable=True)
    gr_few = db.Column(db.Boolean, nullable=False, default=False)

    def flags(self):
        return json.loads(self.flags_json or "[]")

    def effective_qty(self):
        return self.final_qty_user if self.final_qty_user is not None else self.final_qty_computed

    def est_boxes(self, qty=None):
        from . import calc
        return calc.est_boxes(self.effective_qty() if qty is None else qty, self.box_size)

    def est_pallets(self, qty=None):
        from . import calc
        return calc.est_pallets(self.effective_qty() if qty is None else qty, self.box_size)

    def days_after_ship(self, qty=None):
        from . import calc
        return calc.days_after_ship(
            self.hq_qty, self.east_position, self.east_avg_daily,
            self.effective_qty() if qty is None else qty,
        )

    def kpac_hq_split(self, qty=None):
        from . import calc
        return calc.kpac_hq_split(
            self.effective_qty() if qty is None else qty, self.box_size, self.kpac_online,
        )
