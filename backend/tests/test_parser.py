from backend.app.parser import parse_packet


def test_valid_packet():
    line = "0,1000,0.02,-0.05,9.81,0.1,-0.2,0.0,31.4,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,4.12"
    pkt = parse_packet(line)
    assert pkt is not None
    assert pkt.seq == 0
    assert pkt.az == 9.81
    assert pkt.vbat_v == 4.12


def test_rejects_bad_packets():
    bad_lines = [
        "5,500,0.1,0.2",
        "5,500,0.02,-0.05,9.81,0.1,-0.2,0.0,31.4,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,abc",
        "5,500,0.02,-0.05,9.81,0.1,-0.2,0.0,nan,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,4.12",
        "5,500,0.02,-0.05,inf,0.1,-0.2,0.0,31.4,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,4.12",
    ]
    for line in bad_lines:
        assert parse_packet(line) is None