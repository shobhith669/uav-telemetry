"""Turns raw UDP packets into the JSON messages the dashboard expects.

The message format is the agreement in docs/websocket-message.md. This file does the same
checking, processing and alerting as receiver.py, but instead of printing it returns the
message to send to the browser.
"""
from pathlib import Path

from backend.app.anomaly import AnomalyEngine
from backend.app.parser import parse_packet
from backend.app.processor import TelemetryProcessor

MESSAGE_VERSION = 1
CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "thresholds.yaml"


class Pipeline:
    def __init__(self, config_path=CONFIG_PATH):
        self.processor = TelemetryProcessor()
        self.anomaly = AnomalyEngine(str(config_path))
        self.last_seq: int | None = None
        self.last_rx_s: float | None = None  # when the last good packet arrived (monotonic seconds)
        self.packets_lost = 0
        self.packets_invalid = 0

    def handle_datagram(self, data: bytes, now_ms: int, now_s: float) -> dict | None:
        """One UDP packet in. Returns the `telemetry` message, or None if the packet was bad."""
        line = data.decode("utf-8", errors="replace").strip()
        pkt = parse_packet(line)
        if pkt is None:
            self.packets_invalid += 1
            print(f"[INVALID #{self.packets_invalid}] Ignored bad packet")
            return None

        if self.last_seq is not None and pkt.seq > self.last_seq + 1:
            self.packets_lost += pkt.seq - self.last_seq - 1
        self.last_seq = pkt.seq

        try:
            telem = self.processor.process(pkt)
            alerts = self.anomaly.evaluate(telem, now_ms)
        except Exception as exc:  # one bad packet must never stop the backend
            self.packets_invalid += 1
            print(f"[ERROR #{self.packets_invalid}] Skipped packet seq={pkt.seq}: {type(exc).__name__}: {exc}")
            return None

        self.last_rx_s = now_s  # only good packets count as "the link is alive"

        # Same field order as the example in docs/websocket-message.md
        msg = {
            "type": "telemetry",
            "version": MESSAGE_VERSION,
            "seq": telem["seq"],
            "t_ms": telem["t_ms"],
            "rx_unix_ms": now_ms,
        }
        msg.update({k: v for k, v in telem.items() if k not in msg})
        msg["packets_lost"] = self.packets_lost
        msg["packets_invalid"] = self.packets_invalid
        msg["alerts"] = alerts
        return msg

    def check_link(self, now_s: float, now_ms: int) -> dict | None:
        """Call about every 0.5 s while idle. Returns a `link` message once packets have stopped."""
        if self.last_rx_s is None:
            return None  # nothing has arrived yet, so there is nothing to be "late"
        gap = now_s - self.last_rx_s
        alerts = self.anomaly.evaluate_link_gap(gap, now_ms)
        if gap <= self.anomaly.cfg["link"]["warning_above_s"]:
            return None
        return {"type": "link", "since_last_packet_s": round(gap, 1), "alerts": alerts}
