from datetime import timezone
from zoneinfo import ZoneInfo

PACIFIC = ZoneInfo("America/Los_Angeles")


def to_pacific(dt):
    """Stored timestamps are naive UTC (see models.py); this converts them to
    Pacific time for display only — never for storage or comparisons."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(PACIFIC)
