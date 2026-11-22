"""Tests for backend/app/pipeline.py (the JSON messages for the dashboard)."""
from backend.app.pipeline import Pipeline

# Every field in docs/websocket-message.md, in the same order
TELEMETRY_FIELDS = [
    "type", "version", "seq", "t_ms", "rx_unix_ms", "vbat_v", "lat", "lon", "fix", "sats",
    "speed_mps", "alt_rel_m", "vspeed_mps", "roll_deg", "pitch_deg", "heading_deg",
    "heading_valid", "accel_total_g", "temp_c", "packets_lost", "packets_invalid", "alerts",
]


def line(seq, vbat=4.10, press=91150, fix=1, sats=11):
    return (f"{seq},{seq * 100},0.02,-0.05,9.81,0.1,-0.2,0.0,31.4,{press},58.2,"
            f"12.923700,77.498900,880.0,0.0,{sats},{fix},{vbat}").encode()


def feed(p, seq, now_s=None, **kw):
    now_s = seq * 0.1 if now_s is None else now_s
    return p.handle_datagram(line(seq, **kw), 1_000_000 + seq * 100, now_s)


def test_telemetry_message_has_every_agreed_field_in_order():
    msg = feed(Pipeline(), 0)
    assert list(msg.keys()) == TELEMETRY_FIELDS
    assert msg["type"] == "telemetry"
    assert msg["version"] == 1
    assert msg["rx_unix_ms"] == 1_000_000
    assert msg["alerts"] == []
    assert msg["alt_rel_m"] is None  # ground level not set yet: null, not 0


def test_bad_packet_returns_nothing_and_is_counted():
    p = Pipeline()
    assert p.handle_datagram(b"not,a,packet", 1, 0.0) is None
    assert p.handle_datagram(b"\xff\xfe garbage", 1, 0.0) is None
    assert feed(p, 0)["packets_invalid"] == 2


def test_missing_packets_are_counted_from_gaps_in_seq():
    p = Pipeline()
    feed(p, 0)
    feed(p, 1)
    msg = feed(p, 6)  # 2,3,4,5 never arrived
    assert msg["packets_lost"] == 4


def test_processing_error_skips_the_packet_instead_of_crashing():
    p = Pipeline()

    def boom(_pkt):
        raise ValueError("test failure")

    p.processor.process = boom
    assert feed(p, 0) is None
    del p.processor.process  # back to the real method
    msg = feed(p, 1)
    assert msg["packets_invalid"] == 1


def test_alerts_are_included_in_the_message():
    p = Pipeline()
    msg = None
    for i in range(3):
        msg = feed(p, i, vbat=3.2)
    assert [a["parameter"] for a in msg["alerts"]] == ["battery_voltage"]
    assert msg["alerts"][0]["severity"] == "CRITICAL"


def test_no_link_message_before_the_first_packet_or_while_packets_flow():
    p = Pipeline()
    assert p.check_link(100.0, 1) is None
    feed(p, 0, now_s=10.0)
    assert p.check_link(10.3, 1) is None  # only 0.3 s of silence


def test_link_message_after_silence_then_cleared_by_the_next_packet():
    p = Pipeline()
    for i in range(3):
        feed(p, i, now_s=10.0 + i * 0.1, vbat=3.2)  # battery CRITICAL is active
    link = p.check_link(13.2, 5_000)  # 3.0 s after the last packet at 10.2
    assert link["type"] == "link"
    assert link["since_last_packet_s"] == 3.0
    params = {a["parameter"]: a["severity"] for a in link["alerts"]}
    assert params == {"link": "CRITICAL", "battery_voltage": "CRITICAL"}  # nothing disappears

    msg = feed(p, 40, now_s=13.4, vbat=3.2)
    assert [a["parameter"] for a in msg["alerts"]] == ["battery_voltage"]  # link alert gone


def test_link_warning_level():
    p = Pipeline()
    feed(p, 0, now_s=10.0)
    link = p.check_link(10.7, 1)
    assert link["alerts"][0]["severity"] == "WARNING"


def test_garbage_does_not_count_as_a_live_link():
    p = Pipeline()
    feed(p, 0, now_s=10.0)
    p.handle_datagram(b"garbage", 1, 11.0)  # arrives, but is not a good packet
    assert p.check_link(11.1, 1) is not None
