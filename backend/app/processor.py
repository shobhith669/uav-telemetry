import math
from backend.app.parser import Packet

G = 9.81
GROUND_CALIB_SAMPLES = 20  # First ~2 seconds average sets 0 m


class TelemetryProcessor:
    def __init__(self):
        self._press_samples: list[float] = []
        self._p0: float | None = None
        self._alt_smooth: float | None = None
        self._prev_alt: float | None = None
        self._prev_t_ms: int | None = None
        self._vspeed_smooth: float | None = None

        self._roll_deg: float | None = None
        self._pitch_deg: float | None = None

        self._prev_lat: float | None = None
        self._prev_lon: float | None = None
        self._heading_deg: float | None = None

    def process(self, pkt: Packet) -> dict:
        # 1. Relative altitude from pressure (first 2 s sets ground zero)
        alt_rel_m: float | None = None
        vspeed_mps: float | None = None

        if self._p0 is None:
            self._press_samples.append(pkt.press_pa)
            if len(self._press_samples) >= GROUND_CALIB_SAMPLES:
                self._p0 = sum(self._press_samples) / len(self._press_samples)

        if self._p0 is not None and pkt.press_pa > 0:
            raw_alt = 44330.0 * (1.0 - (pkt.press_pa / self._p0) ** 0.1903)
            if self._alt_smooth is None:
                self._alt_smooth = raw_alt
            else:
                self._alt_smooth = 0.7 * self._alt_smooth + 0.3 * raw_alt
            alt_rel_m = round(self._alt_smooth, 2)

            if self._prev_alt is not None and self._prev_t_ms is not None:
                dt = (pkt.t_ms - self._prev_t_ms) / 1000.0
                if dt > 0.01:
                    raw_vs = (self._alt_smooth - self._prev_alt) / dt
                    if self._vspeed_smooth is None:
                        self._vspeed_smooth = raw_vs
                    else:
                        self._vspeed_smooth = 0.6 * self._vspeed_smooth + 0.4 * raw_vs
                    vspeed_mps = round(self._vspeed_smooth, 2)
            self._prev_alt = self._alt_smooth

        # 2. Total acceleration in g
        accel_total_g = round(math.sqrt(pkt.ax**2 + pkt.ay**2 + pkt.az**2) / G, 2)

        # 3. Roll & Pitch (axes per docs/packet-format.md; gy+ is nose down)
        acc_roll = math.degrees(math.atan2(pkt.ay, pkt.az))
        acc_pitch = math.degrees(math.atan2(pkt.ax, math.sqrt(pkt.ay**2 + pkt.az**2)))

        if self._roll_deg is None or self._prev_t_ms is None:
            self._roll_deg = acc_roll
            self._pitch_deg = acc_pitch
        else:
            dt = max(0.0, min((pkt.t_ms - self._prev_t_ms) / 1000.0, 0.5))
            alpha = 0.85
            self._roll_deg = alpha * (self._roll_deg + pkt.gx * dt) + (1 - alpha) * acc_roll
            self._pitch_deg = alpha * (self._pitch_deg - pkt.gy * dt) + (1 - alpha) * acc_pitch

        self._prev_t_ms = pkt.t_ms

        # 4. Heading from GPS travel direction
        heading_valid = False
        if pkt.fix == 1 and pkt.speed_mps > 1.0:
            if self._prev_lat is not None and (pkt.lat != self._prev_lat or pkt.lon != self._prev_lon):
                self._heading_deg = round(self._bearing(self._prev_lat, self._prev_lon, pkt.lat, pkt.lon), 1)
                self._prev_lat, self._prev_lon = pkt.lat, pkt.lon
            elif self._prev_lat is None:
                self._prev_lat, self._prev_lon = pkt.lat, pkt.lon
            heading_valid = self._heading_deg is not None
        elif pkt.fix == 1:
            self._prev_lat, self._prev_lon = pkt.lat, pkt.lon

        return {
            "seq": pkt.seq,
            "t_ms": pkt.t_ms,
            "vbat_v": pkt.vbat_v,
            "lat": pkt.lat,
            "lon": pkt.lon,
            "fix": pkt.fix,
            "sats": pkt.sats,
            "speed_mps": pkt.speed_mps,
            "alt_rel_m": alt_rel_m,
            "vspeed_mps": vspeed_mps,
            "roll_deg": round(self._roll_deg, 1),
            "pitch_deg": round(self._pitch_deg, 1),
            "heading_deg": self._heading_deg,
            "heading_valid": heading_valid,
            "accel_total_g": accel_total_g,
            "temp_c": pkt.temp_c,
        }

    @staticmethod
    def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dlon = math.radians(lon2 - lon1)
        y = math.sin(dlon) * math.cos(p2)
        x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
        return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0