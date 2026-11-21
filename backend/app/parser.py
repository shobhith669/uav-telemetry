from dataclasses import dataclass
import math

EXPECTED_FIELDS = 18


@dataclass
class Packet:
    seq: int
    t_ms: int
    ax: float
    ay: float
    az: float
    gx: float
    gy: float
    gz: float
    temp_c: float
    press_pa: float
    hum_pct: float
    lat: float
    lon: float
    alt_gps_m: float
    speed_mps: float
    sats: int
    fix: int
    vbat_v: float


def parse_packet(line: str) -> Packet | None:
    parts = line.strip().split(",")
    if len(parts) != EXPECTED_FIELDS:
        return None

    try:
        seq = int(parts[0])
        t_ms = int(parts[1])
        floats = [float(x) for x in parts[2:15]]
        sats = int(parts[15])
        fix = int(parts[16])
        vbat_v = float(parts[17])
    except ValueError:
        return None

    if not all(math.isfinite(v) for v in (*floats, vbat_v)):
        return None
    if seq < 0 or t_ms < 0 or sats < 0 or fix not in (0, 1):
        return None

    return Packet(
        seq=seq,
        t_ms=t_ms,
        ax=floats[0],
        ay=floats[1],
        az=floats[2],
        gx=floats[3],
        gy=floats[4],
        gz=floats[5],
        temp_c=floats[6],
        press_pa=floats[7],
        hum_pct=floats[8],
        lat=floats[9],
        lon=floats[10],
        alt_gps_m=floats[11],
        speed_mps=floats[12],
        sats=sats,
        fix=fix,
        vbat_v=vbat_v,
    )