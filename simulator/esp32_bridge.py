import json
import socket
import time
import urllib.request

ESP32_URL = "http://192.168.4.1/data"
UDP_HOST = "127.0.0.1"
UDP_PORT = 5005
POLL_INTERVAL_S = 0.2  # Matches ESP32's 200 ms sample rate (5 Hz)


def num(val, default=0.0):
    return default if val is None else float(val)


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    seq = 0
    print(f"Bridging {ESP32_URL} -> UDP {UDP_HOST}:{UDP_PORT} (Ctrl+C to stop)")

    while True:
        start = time.monotonic()
        try:
            with urllib.request.urlopen(ESP32_URL, timeout=1.0) as resp:
                d = json.loads(resp.read().decode("utf-8"))

            t_ms = int(d.get("uptimeMs", 0))

            # Unit conversions to match docs/packet-format.md
            ax = num(d.get("ax"), 0.0) * 9.81          # g -> m/s^2
            ay = num(d.get("ay"), 0.0) * 9.81          # g -> m/s^2
            az = num(d.get("az"), 1.0) * 9.81          # g -> m/s^2
            gx = num(d.get("gx"), 0.0)                 # deg/s
            gy = num(d.get("gy"), 0.0)                 # deg/s
            gz = num(d.get("gz"), 0.0)                 # deg/s

            temp_c = num(d.get("temperature"), 25.0)   # C
            press_pa = num(d.get("pressure"), 1013.25) * 100.0  # hPa -> Pa
            hum_pct = num(d.get("humidity"), 50.0)     # %

            fix = 1 if d.get("gpsFix") else 0
            lat = num(d.get("latitude"), 0.0)
            lon = num(d.get("longitude"), 0.0)
            alt_gps_m = num(d.get("gpsAltitude"), 0.0)
            speed_mps = num(d.get("gpsSpeed"), 0.0) / 3.6       # km/h -> m/s
            sats = int(num(d.get("satellites"), 0))

            # Placeholder until battery voltage divider is wired on ESP32
            vbat_v = 4.10

            line = (
                f"{seq},{t_ms},"
                f"{ax:.2f},{ay:.2f},{az:.2f},"
                f"{gx:.1f},{gy:.1f},{gz:.1f},"
                f"{temp_c:.1f},{press_pa:.0f},{hum_pct:.1f},"
                f"{lat:.6f},{lon:.6f},{alt_gps_m:.1f},{speed_mps:.2f},"
                f"{sats},{fix},{vbat_v:.2f}\n"
            )
            sock.sendto(line.encode("utf-8"), (UDP_HOST, UDP_PORT))
            seq += 1

        except Exception as e:
            print(f"Waiting for ESP32 ({e})...")

        elapsed = time.monotonic() - start
        time.sleep(max(0.0, POLL_INTERVAL_S - elapsed))


if __name__ == "__main__":
    main()