"""Tests for backend/app/anomaly.py (alert levels, persistence, hysteresis, link gap)."""
from pathlib import Path

from backend.app.anomaly import AnomalyEngine

CONFIG = Path(__file__).resolve().parents[2] / "config" / "thresholds.yaml"


def healthy(**over):
    data = {
        "vbat_v": 4.10, "roll_deg": 0.0, "pitch_deg": 0.0, "accel_total_g": 1.0,
        "vspeed_mps": 0.0, "temp_c": 30.0, "sats": 11, "fix": 1,
    }
    data.update(over)
    return data


class Run:
    """Small helper: feeds packets to an engine at 10 Hz and remembers the clock."""

    def __init__(self):
        self.engine = AnomalyEngine(str(CONFIG))
        self.now = 1_000_000

    def feed(self, n=1, **over):
        alerts = []
        for _ in range(n):
            self.now += 100
            alerts = self.engine.evaluate(healthy(**over), self.now)
        return alerts


def get(alerts, param):
    for a in alerts:
        if a["parameter"] == param:
            return a
    return None


# ---------- basics ----------

def test_healthy_flight_has_no_alerts():
    assert Run().feed(20) == []


def test_alert_needs_three_samples_in_a_row():
    r = Run()
    assert r.feed(2, vbat_v=3.2) == []
    assert get(r.feed(1, vbat_v=3.2), "battery_voltage")["severity"] == "CRITICAL"


def test_one_good_sample_resets_the_count():
    r = Run()
    r.feed(2, vbat_v=3.2)
    r.feed(1)  # healthy again
    assert r.feed(2, vbat_v=3.2) == []


def test_battery_warning_and_critical_messages():
    r = Run()
    a = get(r.feed(3, vbat_v=3.4), "battery_voltage")
    assert (a["severity"], a["message"]) == ("WARNING", "Battery voltage low")
    a = get(r.feed(1, vbat_v=3.2), "battery_voltage")
    assert (a["severity"], a["message"]) == ("CRITICAL", "Battery voltage critical")


# ---------- hysteresis (no flicker) ----------

def test_value_on_the_critical_line_does_not_flicker():
    r = Run()
    first = get(r.feed(3, vbat_v=3.29), "battery_voltage")
    assert first["severity"] == "CRITICAL"
    for _ in range(10):
        for v in (3.31, 3.29):
            a = get(r.feed(1, vbat_v=v), "battery_voltage")
            assert a["severity"] == "CRITICAL"
            assert a["since_unix_ms"] == first["since_unix_ms"]


def test_critical_steps_down_to_warning_only_after_the_margin():
    r = Run()
    r.feed(3, vbat_v=3.2)
    assert get(r.feed(1, vbat_v=3.32), "battery_voltage")["severity"] == "CRITICAL"  # inside the margin
    assert get(r.feed(1, vbat_v=3.36), "battery_voltage")["severity"] == "WARNING"   # clearly better


def test_alert_clears_only_after_hysteresis_and_value_keeps_updating():
    r = Run()
    r.feed(3, vbat_v=3.4)
    a = get(r.feed(1, vbat_v=3.52), "battery_voltage")  # above 3.5 but inside the 0.05 margin
    assert a is not None
    assert a["value"] == 3.52
    assert get(r.feed(1, vbat_v=3.56), "battery_voltage") is None


def test_descent_alert_does_not_flicker_around_critical_limit():
    r = Run()
    assert get(r.feed(3, vspeed_mps=-7.0), "descent_rate")["severity"] == "CRITICAL"
    for _ in range(5):
        assert get(r.feed(1, vspeed_mps=-5.8), "descent_rate")["severity"] == "CRITICAL"
        assert get(r.feed(1, vspeed_mps=-6.2), "descent_rate")["severity"] == "CRITICAL"
    assert get(r.feed(1, vspeed_mps=-5.5), "descent_rate")["severity"] == "WARNING"


# ---------- other rules ----------

def test_descent_alert_and_missing_vertical_speed():
    r = Run()
    a = get(r.feed(3, vspeed_mps=-4.0), "descent_rate")
    assert (a["severity"], a["message"]) == ("WARNING", "High descent rate")
    r2 = Run()
    assert r2.feed(5, vspeed_mps=None) == []  # before calibration there is no vertical speed


def test_climbing_is_not_a_descent():
    assert get(Run().feed(5, vspeed_mps=+8.0), "descent_rate") is None


def test_tilt_uses_the_larger_of_roll_and_pitch():
    r = Run()
    a = get(r.feed(3, roll_deg=0.0, pitch_deg=-50.0), "tilt")
    assert (a["severity"], a["message"]) == ("WARNING", "Excessive tilt angle")
    assert get(r.feed(3, roll_deg=-80.0, pitch_deg=0.0), "tilt")["severity"] == "CRITICAL"


def test_gps_fix_lost_then_recovered():
    r = Run()
    a = get(r.feed(3, fix=0, sats=3), "gps_satellites")
    assert (a["severity"], a["message"]) == ("CRITICAL", "GPS fix lost")
    assert get(r.feed(1, fix=1, sats=11), "gps_satellites") is None


def test_few_satellites_with_fix_is_a_warning_not_critical():
    r = Run()
    a = get(r.feed(3, fix=1, sats=7), "gps_satellites")
    assert (a["severity"], a["message"]) == ("WARNING", "Low GPS satellite count")


def test_high_g_and_temperature_alerts():
    r = Run()
    assert get(r.feed(3, accel_total_g=3.5), "total_acceleration")["severity"] == "WARNING"
    assert get(r.feed(3, accel_total_g=6.5), "total_acceleration")["severity"] == "CRITICAL"
    r = Run()
    assert get(r.feed(3, temp_c=55.0), "enclosure_temperature")["severity"] == "WARNING"
    assert get(r.feed(3, temp_c=70.0), "enclosure_temperature")["severity"] == "CRITICAL"


# ---------- link gap ----------

def test_link_gap_levels():
    r = Run()
    assert get(r.engine.evaluate_link_gap(0.4, r.now), "link") is None
    a = get(r.engine.evaluate_link_gap(0.6, r.now), "link")
    assert a["severity"] == "WARNING"
    a = get(r.engine.evaluate_link_gap(2.5, r.now), "link")
    assert a["severity"] == "CRITICAL"
    assert a["message"] == "No packets for 2.5 s"


def test_next_packet_clears_link_alert_but_keeps_other_alerts():
    r = Run()
    r.feed(3, vbat_v=3.2)
    alerts = r.engine.evaluate_link_gap(3.0, r.now)
    assert get(alerts, "link") is not None
    assert get(alerts, "battery_voltage") is not None
    alerts = r.feed(1, vbat_v=3.2)
    assert get(alerts, "link") is None
    assert get(alerts, "battery_voltage") is not None


# ---------- ordering ----------

def test_alerts_are_sorted_critical_first():
    r = Run()
    alerts = r.feed(3, vbat_v=3.4, roll_deg=80.0)  # battery WARNING, tilt CRITICAL
    assert [a["severity"] for a in alerts] == ["CRITICAL", "WARNING"]
