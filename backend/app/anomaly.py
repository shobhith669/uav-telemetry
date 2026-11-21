from pathlib import Path
import yaml

SEVERITY_RANK = {"CRITICAL": 0, "WARNING": 1, "INFO": 2}


class AnomalyEngine:
    def __init__(self, config_path: str = "config/thresholds.yaml"):
        with open(Path(config_path), "r", encoding="utf-8") as f:
            self.cfg = yaml.safe_load(f)
        self.persist = int(self.cfg.get("persist_samples", 3))
        self._counts: dict[str, int] = {}
        self._active: dict[str, dict] = {}

    def _update_rule(
        self,
        param: str,
        value: float,
        warn_hit: bool,
        crit_hit: bool,
        recovered: bool,
        warn_msg: str,
        crit_msg: str,
        now_ms: int,
    ):
        target_sev = "CRITICAL" if crit_hit else ("WARNING" if warn_hit else None)

        if target_sev is not None:
            self._counts[param] = self._counts.get(param, 0) + 1
            if self._counts[param] >= self.persist or param in self._active:
                prev = self._active.get(param)
                since = prev["since_unix_ms"] if prev else now_ms
                self._active[param] = {
                    "parameter": param,
                    "severity": target_sev,
                    "message": crit_msg if target_sev == "CRITICAL" else warn_msg,
                    "since_unix_ms": since,
                    "value": round(value, 2),
                }
        else:
            self._counts[param] = 0
            if param in self._active and recovered:
                del self._active[param]

    def evaluate(self, data: dict, now_ms: int) -> list[dict]:
        # Clear any link alert because a packet just arrived
        self._active.pop("link", None)

        # 1. Battery voltage (low)
        c = self.cfg["battery_voltage"]
        v = data["vbat_v"]
        self._update_rule(
            "battery_voltage", v,
            warn_hit=v < c["warning_below"],
            crit_hit=v < c["critical_below"],
            recovered=v >= c["warning_below"] + c["hysteresis"],
            warn_msg="Battery voltage low",
            crit_msg="Battery voltage critical",
            now_ms=now_ms,
        )

        # 2. Tilt (max of |roll|, |pitch|)
        c = self.cfg["tilt"]
        tilt = max(abs(data["roll_deg"]), abs(data["pitch_deg"]))
        self._update_rule(
            "tilt", tilt,
            warn_hit=tilt > c["warning_above"],
            crit_hit=tilt > c["critical_above"],
            recovered=tilt <= c["warning_above"] - c["hysteresis"],
            warn_msg="Excessive tilt angle",
            crit_msg="Critical tilt angle",
            now_ms=now_ms,
        )

        # 3. Total acceleration
        c = self.cfg["total_acceleration"]
        g = data["accel_total_g"]
        self._update_rule(
            "total_acceleration", g,
            warn_hit=g > c["warning_above"],
            crit_hit=g > c["critical_above"],
            recovered=g <= c["warning_above"] - c["hysteresis"],
            warn_msg="High G-force",
            crit_msg="Critical G-force",
            now_ms=now_ms,
        )

        # 4. Descent rate (positive number when falling)
        if data["vspeed_mps"] is not None:
            c = self.cfg["descent_rate"]
            descent = max(0.0, -data["vspeed_mps"])
            self._update_rule(
                "descent_rate", descent,
                warn_hit=descent > c["warning_above"],
                crit_hit=descent > c["critical_above"],
                recovered=descent <= c["warning_above"] - c["hysteresis"],
                warn_msg="High descent rate",
                crit_msg="Critical descent rate",
                now_ms=now_ms,
            )

        # 5. Enclosure temperature
        c = self.cfg["enclosure_temperature"]
        temp = data["temp_c"]
        self._update_rule(
            "enclosure_temperature", temp,
            warn_hit=temp > c["warning_above"],
            crit_hit=temp > c["critical_above"],
            recovered=temp <= c["warning_above"] - c["hysteresis"],
            warn_msg="Enclosure temperature high",
            crit_msg="Enclosure temperature critical",
            now_ms=now_ms,
        )

        # 6. GPS satellites / fix
        c = self.cfg["gps_satellites"]
        sats = data["sats"]
        no_fix = data["fix"] == 0
        self._update_rule(
            "gps_satellites", float(sats),
            warn_hit=sats < c["warning_below"],
            crit_hit=no_fix or sats < c["critical_below"],
            recovered=(not no_fix) and sats >= c["warning_below"] + c["hysteresis"],
            warn_msg="Low GPS satellite count",
            crit_msg="GPS fix lost" if no_fix else "Critical GPS satellite count",
            now_ms=now_ms,
        )

        return self.active_alerts()

    def evaluate_link_gap(self, since_last_s: float, now_ms: int) -> list[dict]:
        c = self.cfg["link"]
        if since_last_s > c["warning_above_s"]:
            sev = "CRITICAL" if since_last_s > c["critical_above_s"] else "WARNING"
            prev = self._active.get("link")
            since = prev["since_unix_ms"] if prev else now_ms
            self._active["link"] = {
                "parameter": "link",
                "severity": sev,
                "message": f"No packets for {since_last_s:.1f} s",
                "since_unix_ms": since,
                "value": round(since_last_s, 1),
            }
        return self.active_alerts()

    def active_alerts(self) -> list[dict]:
        return sorted(self._active.values(), key=lambda a: SEVERITY_RANK.get(a["severity"], 99))