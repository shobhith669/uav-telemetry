import argparse
import math
import random
import socket
import time

HOST = "127.0.0.1"
PORT = 5005
RATE_HZ = 10
DT = 1.0 / RATE_HZ

# Ground reference near RVCE (Bengaluru)
BASE_LAT = 12.923700
BASE_LON = 77.498900
BASE_ALT_M = 880.0
BASE_PRESS_PA = 91150.0
CIRCLE_RADIUS_M = 85.3  # ~6.7 m/s over an 80 s full circle
MISSION_LEN_S = 160.0
G = 9.81


def pressure_from_rel_alt(rel_alt_m: float) -> float:
    return BASE_PRESS_PA * ((1.0 - 2.25577e-5 * rel_alt_m) ** 5.25588)


def main():
    parser = argparse.ArgumentParser(description="Simulated UAV UDP telemetry sender")
    parser.add_argument("--print", dest="do_print", action="store_true", help="Print sent packets")
    parser.add_argument("--no-faults", action="store_true", help="Run a clean flight with no faults")
    parser.add_argument("--start-at", type=float, default=0.0, help="Start mission at N seconds")
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    seq = 0

    # Last known GPS values (updated once per second, repeated when fix=0)
    last_lat = BASE_LAT
    last_lon = BASE_LON
    last_alt_gps = BASE_ALT_M
    last_speed = 0.0
    last_sats = 11
    last_fix = 1
    last_gps_sec = -1

    start_wall = time.monotonic()
    print(f"Sending 10 Hz UDP packets to {HOST}:{PORT} ... (Ctrl+C to stop)")

    try:
        while True:
            elapsed = time.monotonic() - start_wall
            mission_t = (elapsed + args.start_at) % MISSION_LEN_S
            t_ms = int((elapsed + args.start_at) * 1000)

            # 1. Mission profile (160 s loop)
            if mission_t < 10.0:
                rel_alt, speed, angle = 0.0, 0.0, 0.0
            elif mission_t < 30.0:
                rel_alt = 4.0 * (mission_t - 10.0)  # Climb 0 -> 80 m
                speed, angle = 0.0, 0.0
            elif mission_t < 110.0:
                rel_alt = 80.0
                speed = 6.7
                angle = 2.0 * math.pi * ((mission_t - 30.0) / 80.0)
            elif mission_t < 150.0:
                rel_alt = 80.0 - 2.0 * (mission_t - 110.0)  # Descend 80 -> 0 m
                speed, angle = 0.0, 0.0
            else:
                rel_alt, speed, angle = 0.0, 0.0, 0.0

            roll_deg = 3.0 if 30.0 <= mission_t < 110.0 else 0.0
            pitch_deg = -1.5 if 30.0 <= mission_t < 110.0 else 0.0
            skip_packet = False

            # 2. Fault injections (disabled with --no-faults)
            if not args.no_faults:
                # Tilt spike near 55 deg (65-68 s)
                if 65.0 <= mission_t < 68.0:
                    roll_deg = 55.0
                # Sudden 18 m altitude drop (80-83 s, then climbs back)
                if 80.0 <= mission_t < 83.0:
                    rel_alt -= 6.0 * (mission_t - 80.0)
                elif 83.0 <= mission_t < 89.0:
                    rel_alt -= 18.0 - 3.0 * (mission_t - 83.0)
                # 3.5 s packet gap (95-98.5 s)
                if 95.0 <= mission_t < 98.5:
                    skip_packet = True

            # 3. IMU (m/s^2 and deg/s, matching docs/packet-format.md axes)
            roll_rad = math.radians(roll_deg)
            pitch_rad = math.radians(pitch_deg)
            ax = G * math.sin(pitch_rad) + random.uniform(-0.05, 0.05)
            ay = G * math.sin(roll_rad) + random.uniform(-0.05, 0.05)
            az = G * math.cos(roll_rad) * math.cos(pitch_rad) + random.uniform(-0.05, 0.05)
            gx = random.uniform(-0.4, 0.4)
            gy = random.uniform(-0.4, 0.4)
            gz = (4.5 if 30.0 <= mission_t < 110.0 else 0.0) + random.uniform(-0.3, 0.3)

            # 4. BME280 (temp, pressure, humidity)
            temp_c = 31.5 + 3.0 * (mission_t / MISSION_LEN_S) + random.uniform(-0.1, 0.1)
            press_pa = pressure_from_rel_alt(rel_alt) + random.uniform(-3.0, 3.0)
            hum_pct = 58.0 + random.uniform(-0.3, 0.3)

            # 5. Battery drain (drains past 3.5 V and 3.3 V unless --no-faults)
            if args.no_faults:
                vbat_v = 4.15 - 0.35 * (mission_t / MISSION_LEN_S)
            else:
                vbat_v = 4.15 - 0.95 * (mission_t / MISSION_LEN_S)

            # 6. NEO-7M GPS updates once per second
            current_sec = int(elapsed + args.start_at)
            if current_sec != last_gps_sec:
                last_gps_sec = current_sec
                if not args.no_faults and 45.0 <= mission_t < 55.0:
                    last_sats = 3
                    last_fix = 0
                else:
                    last_sats = 11
                    last_fix = 1
                    d_north = CIRCLE_RADIUS_M * math.sin(angle) if 30.0 <= mission_t < 110.0 else 0.0
                    d_east = CIRCLE_RADIUS_M * (math.cos(angle) - 1.0) if 30.0 <= mission_t < 110.0 else 0.0
                    last_lat = BASE_LAT + (d_north / 111111.0)
                    last_lon = BASE_LON + (d_east / (111111.0 * math.cos(math.radians(BASE_LAT))))
                    last_alt_gps = BASE_ALT_M + rel_alt
                    last_speed = speed

            # 7. Format and send exact 18-field CSV line (seq increments even on gaps)
            if not skip_packet:
                packet = (
                    f"{seq},{t_ms},"
                    f"{ax:.2f},{ay:.2f},{az:.2f},"
                    f"{gx:.1f},{gy:.1f},{gz:.1f},"
                    f"{temp_c:.1f},{press_pa:.0f},{hum_pct:.1f},"
                    f"{last_lat:.6f},{last_lon:.6f},{last_alt_gps:.1f},{last_speed:.1f},"
                    f"{last_sats},{last_fix},{vbat_v:.2f}\n"
                )
                sock.sendto(packet.encode("utf-8"), (HOST, PORT))
                if args.do_print:
                    print(packet.strip())

            seq += 1
            next_tick = start_wall + seq * DT
            sleep_time = next_tick - time.monotonic()
            if sleep_time > 0:
                time.sleep(sleep_time)
    except KeyboardInterrupt:
        print("\nStopped simulator.")
    finally:
        sock.close()


if __name__ == "__main__":
    main()