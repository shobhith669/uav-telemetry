"""Tests for backend/app/main.py: a real UDP packet in, a WebSocket message out."""
import socket
import threading

import pytest
import yaml
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.pipeline import CONFIG_PATH


def packet(seq):
    return (f"{seq},{seq * 100},0.02,-0.05,9.81,0.1,-0.2,0.0,31.4,91150,58.2,"
            f"12.923700,77.498900,880.0,0.0,11,1,4.12\n").encode()


PACKET = packet(7)


def free_udp_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def send_udp(port, data=PACKET):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(data, ("127.0.0.1", port))
    s.close()


def receive(ws, seconds=5):
    """receive_json() waits forever if nothing comes, so give up after a few seconds."""
    box = {}

    def run():
        box["msg"] = ws.receive_json()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    assert not t.is_alive(), "no WebSocket message arrived"
    return box["msg"]


def test_dashboard_page_and_files_are_served():
    port = free_udp_port()
    with TestClient(create_app(udp_port=port)) as client:
        page = client.get("/")
        assert page.status_code == 200
        assert "BLACK BOX" in page.text
        assert client.get("/static/style.css").status_code == 200
        assert client.get("/static/app.js").status_code == 200
        # every file the page loads must be served, or the page breaks (the map and graphs libraries are local files)
        for path in ("/static/graphs.js", "/static/map.js", "/static/vendor/echarts.min.js",
                     "/static/vendor/leaflet/leaflet.js", "/static/vendor/leaflet/leaflet.css"):
            assert client.get(path).status_code == 200, path
        assert 'id="tab-map"' in page.text
        assert 'id="p-alerts"' in page.text


def test_udp_packet_arrives_in_the_browser_as_telemetry():
    port = free_udp_port()
    with TestClient(create_app(udp_port=port)) as client:
        with client.websocket_connect("/ws") as ws:
            send_udp(port)
            msg = receive(ws)
    assert msg["type"] == "telemetry"
    assert msg["seq"] == 7
    assert msg["vbat_v"] == 4.12
    assert msg["alerts"] == []


def test_a_page_opened_late_gets_the_history_first_then_live_messages():
    port = free_udp_port()
    with TestClient(create_app(udp_port=port)) as client:
        with client.websocket_connect("/ws") as first:
            send_udp(port, packet(7))
            receive(first)
            send_udp(port, packet(8))
            receive(first)
            with client.websocket_connect("/ws") as late:
                history = receive(late)
                assert history["type"] == "history"
                assert [m["seq"] for m in history["messages"]] == [7, 8]
                send_udp(port, packet(9))
                assert receive(late)["seq"] == 9  # and the live stream carries on


def test_thresholds_endpoint_returns_the_limits_the_alert_engine_uses():
    port = free_udp_port()
    with TestClient(create_app(udp_port=port)) as client:
        data = client.get("/api/thresholds").json()
    assert data == yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))


def test_bad_udp_packet_sends_nothing_but_the_next_good_one_counts_it():
    port = free_udp_port()
    with TestClient(create_app(udp_port=port)) as client:
        with client.websocket_connect("/ws") as ws:
            send_udp(port, b"this is not a packet")
            send_udp(port)
            msg = receive(ws)
    assert msg["seq"] == 7
    assert msg["packets_invalid"] == 1


def test_clear_error_if_the_udp_port_is_already_taken():
    blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    blocker.bind(("0.0.0.0", 0))
    port = blocker.getsockname()[1]
    try:
        with pytest.raises(RuntimeError, match="Cannot listen on UDP port"):
            with TestClient(create_app(udp_port=port)):
                pass
    finally:
        blocker.close()
