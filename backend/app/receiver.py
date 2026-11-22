import socket
import time

from backend.app.anomaly import AnomalyEngine
from backend.app.parser import parse_packet
from backend.app.processor import TelemetryProcessor

HOST = "0.0.0.0"
PORT = 5005


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((HOST, PORT))
    sock.settimeout(0.5)

    processor = TelemetryProcessor()
    anomaly = AnomalyEngine()

    last_seq: int | None = None
    last_rx_wall: float | None = None
    packets_lost = 0
    packets_invalid = 0

    print(f"Backend receiver + anomaly engine listening on UDP {PORT} ... (Ctrl+C to stop)")

    try:
        while True:
            try:
                data, _ = sock.recvfrom(4096)
            except socket.timeout:
                if last_rx_wall is not None:
                    gap = time.monotonic() - last_rx_wall
                    alerts = anomaly.evaluate_link_gap(gap, int(time.time() * 1000))
                    for a in alerts:
                        if a["parameter"] == "link":
                            print(f"  >>> [{a['severity']}] {a['message']}")
                continue

            now_ms = int(time.time() * 1000)  # taken after the packet arrived, not before waiting for it
            last_rx_wall = time.monotonic()
            line = data.decode("utf-8", errors="replace").strip()
            pkt = parse_packet(line)

            if pkt is None:
                packets_invalid += 1
                print(f"[INVALID #{packets_invalid}] Ignored bad packet")
                continue

            if last_seq is not None and pkt.seq > last_seq + 1:
                packets_lost += pkt.seq - last_seq - 1
            last_seq = pkt.seq

            try:
                telem = processor.process(pkt)
                alerts = anomaly.evaluate(telem, now_ms)
            except Exception as exc:  # one bad packet must never stop the backend
                packets_invalid += 1
                print(f"[ERROR #{packets_invalid}] Skipped packet seq={pkt.seq}: {type(exc).__name__}: {exc}")
                continue

            alt_str = f"{telem['alt_rel_m']:5.1f}m" if telem["alt_rel_m"] is not None else "  -- "
            vs_str = f"{telem['vspeed_mps']:+5.1f}m/s" if telem["vspeed_mps"] is not None else "   --  "
            hdg_str = f"{telem['heading_deg']:5.1f}d" if telem["heading_valid"] else "  -- "

            print(
                f"seq={telem['seq']:4d} | alt={alt_str} vs={vs_str} | "
                f"roll={telem['roll_deg']:+5.1f} pitch={telem['pitch_deg']:+5.1f} | "
                f"g={telem['accel_total_g']:.2f} | hdg={hdg_str} | "
                f"vbat={telem['vbat_v']:.2f}V | lost={packets_lost}"
            )
            for a in alerts:
                print(f"  >>> [{a['severity']}] {a['parameter']}: {a['message']} (value={a['value']})")
    except KeyboardInterrupt:
        print(f"\nStopped. Total lost={packets_lost}, invalid={packets_invalid}")
    finally:
        sock.close()


if __name__ == "__main__":
    main()