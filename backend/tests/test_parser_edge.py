"""Extra parser checks (kept in a separate file from test_parser.py)."""
from backend.app.parser import parse_packet

GOOD = "0,1000,0.02,-0.05,9.81,0.1,-0.2,0.0,31.4,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,4.12"


def test_fix_must_be_0_or_1():
    assert parse_packet(GOOD) is not None
    assert parse_packet(GOOD.replace(",11,1,4.12", ",11,2,4.12")) is None


def test_wrong_number_of_fields_is_rejected():
    assert parse_packet(GOOD + ",5") is None            # 19 fields
    assert parse_packet(GOOD.rsplit(",", 1)[0]) is None  # 17 fields
    assert parse_packet("") is None


def test_line_endings_are_ignored():
    assert parse_packet(GOOD + "\r\n") is not None
    assert parse_packet(GOOD + "\n") is not None
