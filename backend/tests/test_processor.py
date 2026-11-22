"""Tests for backend/app/processor.py (altitude, attitude, g-force, heading)."""
from backend.app.parser import parse_packet
from backend.app.processor import GROUND_CALIB_SAMPLES, TelemetryProcessor

BASE_LAT = 12.923700
BASE_LON = 77.498900
GROUND_PRESS = 91150


def make(seq=0, t_ms=None, ax=0.0, ay=0.0, az=9.81, gx=0.0, gy=0.0, gz=0.0,
         press=GROUND_PRESS, lat=BASE_LAT, lon=BASE_LON, speed=0.0, sats=11, fix=1):
    """Build one parsed packet. Defaults = drone sitting level on the ground."""
    if t_ms is None:
        t_ms = seq * 100  # 10 Hz
    line = (f"{seq},{t_ms},{ax},{ay},{az},{gx},{gy},{gz},"
            f"30.0,{press},58.0,{lat:.6f},{lon:.6f},880.0,{speed},{sats},{fix},4.10")
    pkt = parse_packet(line)
    assert pkt is not None
    return pkt


def calibrated(proc=None, start_seq=0):
    """Feed the ground samples so the processor knows where 0 m is. Returns (processor, next_seq)."""
    proc = proc or TelemetryProcessor()
    for i in range(GROUND_CALIB_SAMPLES):
        proc.process(make(seq=start_seq + i))
    return proc, start_seq + GROUND_CALIB_SAMPLES


def angle_diff(a, b):
    return abs((a - b + 180.0) % 360.0 - 180.0)


# ---------- altitude ----------

def test_altitude_is_none_until_ground_is_calibrated():
    proc = TelemetryProcessor()
    for i in range(GROUND_CALIB_SAMPLES - 1):
        assert proc.process(make(seq=i))["alt_rel_m"] is None
    out = proc.process(make(seq=GROUND_CALIB_SAMPLES - 1))
    assert out["alt_rel_m"] is not None
    assert abs(out["alt_rel_m"]) < 0.5  # sitting on the ground = about 0 m


def test_zero_pressure_at_start_does_not_crash():
    # A sensor that is not ready yet can send 0 Pa. It must not become "ground level".
    proc = TelemetryProcessor()
    for i in range(GROUND_CALIB_SAMPLES):
        assert proc.process(make(seq=i, press=0))["alt_rel_m"] is None
    for i in range(GROUND_CALIB_SAMPLES - 1):
        assert proc.process(make(seq=100 + i))["alt_rel_m"] is None
    out = proc.process(make(seq=200))
    assert out["alt_rel_m"] is not None
    assert abs(out["alt_rel_m"]) < 0.5


def test_a_few_zero_pressure_samples_do_not_shift_ground_level():
    proc = TelemetryProcessor()
    proc.process(make(seq=0, press=0))
    proc.process(make(seq=1, press=0))
    out = None
    for i in range(2, 2 + GROUND_CALIB_SAMPLES):
        out = proc.process(make(seq=i))
    assert out["alt_rel_m"] is not None
    assert abs(out["alt_rel_m"]) < 1.0


def test_altitude_rises_when_pressure_drops():
    proc, seq = calibrated()
    out = None
    for i in range(40):
        out = proc.process(make(seq=seq + i, press=90200))  # ~95 hPa lower = about 88 m up
    assert 80 < out["alt_rel_m"] < 95


def test_vertical_speed_sign():
    proc, seq = calibrated()
    out = None
    for i in range(10):  # pressure falling steadily = climbing
        out = proc.process(make(seq=seq + i, press=GROUND_PRESS - 10 * (i + 1)))
    assert out["vspeed_mps"] > 2

    proc, seq = calibrated()
    for i in range(10):  # pressure rising steadily = descending
        out = proc.process(make(seq=seq + i, press=GROUND_PRESS + 10 * (i + 1)))
    assert out["vspeed_mps"] < -2


# ---------- g-force and attitude ----------

def test_total_g():
    assert TelemetryProcessor().process(make(az=9.81))["accel_total_g"] == 1.0
    assert TelemetryProcessor().process(make(az=19.62))["accel_total_g"] == 2.0


def test_roll_sign_right_wing_down_is_positive():
    out = TelemetryProcessor().process(make(ay=4.9, az=8.5))  # about 30 degrees
    assert 29 < out["roll_deg"] < 31
    assert abs(out["pitch_deg"]) < 1


def test_pitch_sign_nose_up_is_positive():
    out = TelemetryProcessor().process(make(ax=4.9, az=8.5))  # about 30 degrees
    assert 29 < out["pitch_deg"] < 31
    assert abs(out["roll_deg"]) < 1


# ---------- heading ----------

def test_heading_east_and_north():
    proc = TelemetryProcessor()
    out = None
    for i in range(5):
        out = proc.process(make(seq=i, lon=BASE_LON + 0.0001 * i, speed=6.0))
    assert out["heading_valid"] is True
    assert angle_diff(out["heading_deg"], 90.0) < 1.0

    proc = TelemetryProcessor()
    for i in range(5):
        out = proc.process(make(seq=i, lat=BASE_LAT + 0.0001 * i, speed=6.0))
    assert out["heading_valid"] is True
    assert angle_diff(out["heading_deg"], 0.0) < 1.0


def test_heading_needs_a_second_position():
    out = TelemetryProcessor().process(make(speed=6.0))
    assert out["heading_valid"] is False
    assert out["heading_deg"] is None


def test_standing_still_keeps_last_heading_but_marks_it_not_valid():
    proc = TelemetryProcessor()
    for i in range(5):
        proc.process(make(seq=i, lon=BASE_LON + 0.0001 * i, speed=6.0))
    out = proc.process(make(seq=5, lon=BASE_LON + 0.0004, speed=0.0))
    assert out["heading_valid"] is False
    assert angle_diff(out["heading_deg"], 90.0) < 1.0


def test_heading_is_not_trusted_right_after_gps_comes_back():
    proc = TelemetryProcessor()
    out = None
    for i in range(5):  # flying east
        out = proc.process(make(seq=i, lon=BASE_LON + 0.0001 * i, speed=6.0))
    assert out["heading_valid"] is True

    last_lon = BASE_LON + 0.0004
    for i in range(5, 15):  # GPS lost: position is frozen, fix=0
        out = proc.process(make(seq=i, lon=last_lon, speed=6.0, sats=3, fix=0))
        assert out["heading_valid"] is False

    # GPS is back, and the drone is now far away (north-east). The jump from the old
    # position is not a real direction of travel, so the first packet must not count.
    out = proc.process(make(seq=15, lat=BASE_LAT + 0.0005, lon=last_lon + 0.0010, speed=6.0))
    assert out["heading_valid"] is False

    # Now it moves north: the next bearing is real.
    out = proc.process(make(seq=16, lat=BASE_LAT + 0.0006, lon=last_lon + 0.0010, speed=6.0))
    assert out["heading_valid"] is True
    assert angle_diff(out["heading_deg"], 0.0) < 1.0
