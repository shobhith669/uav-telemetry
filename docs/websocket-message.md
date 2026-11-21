# WebSocket Message (version 1): backend to dashboard

Last updated: 21 Nov 2026
Status: **AGREED**
Used by: backend (sends), dashboard (receives)

## What this is

After the backend checks and processes each packet, it sends one JSON message to the browser. The dashboard listens and updates the numbers, graphs, map and alerts. This file is the agreement between whoever writes the backend and whoever writes the dashboard.

## Connection

- Address: `ws://localhost:8000/ws`
- The backend sends one `telemetry` message for every valid packet, about 10 per second.
- If the connection closes, the dashboard shows "Backend disconnected" and tries again every few seconds.

## The telemetry message

Example, in the circling phase with the battery getting low:

```json
{
  "type": "telemetry",
  "version": 1,
  "seq": 812,
  "t_ms": 81200,
  "rx_unix_ms": 1795256130123,
  "vbat_v": 3.46,
  "lat": 12.923912,
  "lon": 77.499204,
  "fix": 1,
  "sats": 11,
  "speed_mps": 6.7,
  "alt_rel_m": 80.2,
  "vspeed_mps": 0.1,
  "roll_deg": 3.2,
  "pitch_deg": -1.4,
  "heading_deg": 215.0,
  "heading_valid": true,
  "accel_total_g": 1.02,
  "temp_c": 34.1,
  "packets_lost": 0,
  "packets_invalid": 0,
  "alerts": [
    {
      "parameter": "battery_voltage",
      "severity": "WARNING",
      "message": "Battery voltage low",
      "since_unix_ms": 1795256128900,
      "value": 3.46
    }
  ]
}
```

## The fields

| Field | Unit | Meaning | Can be `null`? |
| --- | --- | --- | --- |
| `type` | text | Always `"telemetry"` for this message | No |
| `version` | number | Message format version, 1 for now | No |
| `seq` | count | Packet id from the drone | No |
| `t_ms` | ms | Drone time since it started | No |
| `rx_unix_ms` | ms | Laptop clock time when the packet arrived (Unix time) | No |
| `vbat_v` | V | Battery voltage | No |
| `lat`, `lon` | degrees | Position. Last known value when `fix` is 0 | No |
| `fix` | 0 or 1 | GPS fix | No |
| `sats` | count | GPS satellites in use | No |
| `speed_mps` | m/s | Ground speed. Last known value when `fix` is 0 | No |
| `alt_rel_m` | m | Height above the starting point, from pressure | Yes, until the ground level is set |
| `vspeed_mps` | m/s | Vertical speed. Positive is up, negative is down | Yes, at the very start |
| `roll_deg` | degrees | Roll angle. Positive = right wing down | No |
| `pitch_deg` | degrees | Pitch angle. Positive = nose up | No |
| `heading_deg` | degrees | Direction of travel over the ground, 0 to 360, 0 = north | Yes, until the first valid heading |
| `heading_valid` | true/false | `true` if `heading_deg` is up to date | No |
| `accel_total_g` | g | Total acceleration. About 1.0 at rest | No |
| `temp_c` | °C | Enclosure temperature | No |
| `packets_lost` | count | Total packets missed so far (from gaps in `seq`) | No |
| `packets_invalid` | count | Total bad packets thrown away so far | No |
| `alerts` | list | Alerts that are active right now. Empty list `[]` when all is fine | No |

## Relative altitude

`alt_rel_m` is measured from the ground level the backend works out from its first few seconds of data. If the backend starts after takeoff (or the simulator starts in the air with `--start-at`), that zero is wrong and the height will be wrong by the same amount. A "reset zero" button can be added later.

## Heading

`heading_deg` is the direction the drone is **travelling**, worked out from GPS. It is not where the nose points.

- When `heading_valid` is `true`, show the number.
- When `heading_valid` is `false` (not moving, or no GPS fix), `heading_deg` holds the last good value. Grey it out or show `--`.
- Label it "Heading (GPS)", not "Yaw".

## When `fix` is 0

The position, ground speed and heading are old. The dashboard greys them out, and the map marker should look different (for example faded) so nobody trusts it.

## Alerts

Each item in `alerts` has:

| Field | Meaning |
| --- | --- |
| `parameter` | What is wrong, one of the names below |
| `severity` | `"INFO"`, `"WARNING"` or `"CRITICAL"` |
| `message` | Short text to show the user |
| `since_unix_ms` | Laptop clock time when the alert started |
| `value` | The value that caused it |

Parameter names:

| `parameter` | What it checks |
| --- | --- |
| `battery_voltage` | Battery too low |
| `tilt` | Roll or pitch too large |
| `total_acceleration` | Too many g |
| `descent_rate` | Falling too fast |
| `enclosure_temperature` | Too hot inside |
| `gps_satellites` | Too few satellites, or no fix |
| `link` | Packets arriving late |

An alert stays in the list until the value has recovered past a margin, so alerts do not flicker on and off. The limits live in `config/thresholds.yaml`, not in this file.

The dashboard replaces its whole alert list with the `alerts` from the newest message, whichever type it is. It shows CRITICAL alerts first.

## The link message

When no packet has arrived for more than 0.5 s there are no telemetry messages, so the backend sends this message every 0.5 s until packets come back:

```json
{
  "type": "link",
  "since_last_packet_s": 2.4,
  "alerts": [
    {
      "parameter": "link",
      "severity": "CRITICAL",
      "message": "No packets for 2.4 s",
      "since_unix_ms": 1795256127600,
      "value": 2.4
    }
  ]
}
```

Its `alerts` list holds every alert still active (the last known ones plus the `link` alert), so nothing disappears from the dashboard while the drone is silent. The dashboard also shows "No data" and the time since the last packet.

## Rules

1. Every message has a `type`. The dashboard ignores types and fields it does not know, so new things can be added safely.
2. Do not rename or remove a field without telling the other person first. Adding a field is fine.
3. `null` means "not known yet". Show `--`, never `0`.
4. If a change would break the dashboard, increase `version` and add a line to the change log.
5. Units are fixed as shown in the table.

## Later ideas (not part of version 1)

- A history of past alerts as a new message type.
- A replay mode flag, once post-flight replay exists.
- A "reset zero" button for relative altitude.

## Change log

| Version | Date | Change |
| --- | --- | --- |
| 1 | 21 Nov 2026 | First version, including `heading_deg`, `heading_valid` and the `link` message |
