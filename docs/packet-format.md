# Packet Format (version 1)

Last updated: 21 Nov 2026
Status: **AGREED**
Used by: ESP32 firmware, simulator, backend receiver

## What this is

Every time the ESP32 sends a reading, it sends one line of text called a **packet**. The simulator sends exactly the same kind of line, so the backend cannot tell a simulated drone from the real one.

## The basics

- One packet is one line of numbers separated by commas (CSV), in plain text, ending with a newline. The backend ignores the newline (`\n` or `\r\n`) when reading it.
- Each packet travels in one UDP datagram to port 5005 on the laptop.
- About 10 packets per second.
- Always exactly 18 fields, in the order below.
- Numbers only: no header line, no text, no spaces.
- Decimals use a dot (`12.923700`), never a comma.
- The microSD log is meant to hold the same lines, one per line, so live data and post-flight data go through the same code.

## The 18 fields

| # | Field | Unit | Meaning | Notes |
| --- | --- | --- | --- | --- |
| 1 | `seq` | count | Packet counter | Starts at 0, +1 for every packet even if it is lost, so gaps reveal packet loss |
| 2 | `t_ms` | ms | Time since the ESP32 started | From `millis()`. Not clock time |
| 3 | `ax` | m/s² | Acceleration, x axis | Level and at rest: about 0 |
| 4 | `ay` | m/s² | Acceleration, y axis | Level and at rest: about 0 |
| 5 | `az` | m/s² | Acceleration, z axis | Level and at rest: about +9.81 |
| 6 | `gx` | °/s | Rotation rate around x | From the BMI270. See "Axes and angles" |
| 7 | `gy` | °/s | Rotation rate around y | From the BMI270. See "Axes and angles" |
| 8 | `gz` | °/s | Rotation rate around z | From the BMI270. See "Axes and angles" |
| 9 | `temp_c` | °C | Temperature | BME280, inside the enclosure |
| 10 | `press_pa` | Pa | Air pressure | BME280. Altitude is worked out on the laptop |
| 11 | `hum_pct` | % | Humidity | BME280 |
| 12 | `lat` | degrees | Latitude | 6 decimals. Last known value when `fix` is 0 |
| 13 | `lon` | degrees | Longitude | 6 decimals. Last known value when `fix` is 0 |
| 14 | `alt_gps_m` | m | GPS altitude | From the MAX-M10S. Last known value when `fix` is 0 |
| 15 | `speed_mps` | m/s | Ground speed | From the MAX-M10S. Last known value when `fix` is 0 |
| 16 | `sats` | count | Satellites in use | GPS quality |
| 17 | `fix` | 0 or 1 | GPS fix | 1 means the position is valid |
| 18 | `vbat_v` | V | Battery voltage | Read through a resistor divider on an ESP32 ADC1 pin |

The full line, in order:

```
seq,t_ms,ax,ay,az,gx,gy,gz,temp_c,press_pa,hum_pct,lat,lon,alt_gps_m,speed_mps,sats,fix,vbat_v
```

## Examples

On the ground, level and at rest, GPS fixed:

```
0,1000,0.02,-0.05,9.81,0.1,-0.2,0.0,31.4,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,4.12
```

In flight, GPS fix lost (position, altitude and speed repeat the last known values):

```
412,41200,0.10,-0.12,9.79,1.5,-0.7,0.4,33.0,90400,57.0,12.923912,77.499204,960.0,6.7,3,0,3.91
```

These are **invalid** and are counted, not used:

```
5,500,0.1,0.2
5,500,0.02,-0.05,9.81,0.1,-0.2,0.0,31.4,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,abc
5,500,0.02,-0.05,9.81,0.1,-0.2,0.0,nan,91150,58.2,12.923700,77.498900,880.0,0.0,11,1,4.12
```

The first has too few fields. The second has a field that is not a number. The third has `nan` ("not a number"), which Python's `float()` accepts as a number, so the backend must reject `nan` and `inf` on purpose.

## Axes and angles

Imagine the drone seen from above with its nose pointing forward:

- **x** points to the nose
- **y** points to the left wing
- **z** points up

Level and at rest, gravity makes the accelerometer read `az` ≈ +9.81.

The angles the dashboard shows:

- Positive **roll** = right wing down. It makes `ay` positive.
- Positive **pitch** = nose up. It makes `ax` positive.

The gyro rates follow the right-hand rule around each axis, so:

- `gx` positive = right wing down (same direction as positive roll)
- `gy` positive = nose **down** (opposite to positive pitch, so watch out)
- `gz` positive = nose turns left

The BMI270 board has its own axis markings. The **firmware** must swap or flip the sensor's axes so the numbers match this section, however the board is mounted. The backend does not correct for this.

## When GPS has no fix (`fix` = 0)

The firmware sends the last known `lat`, `lon`, `alt_gps_m` and `speed_mps` unchanged. These numbers are old, so the dashboard greys out position, speed and heading while `fix` is 0.

## When a sensor fails

The firmware never sends `nan`, `inf`, empty fields or invented numbers. If a sensor read fails, it skips sending that packet but still adds 1 to `seq`. The laptop sees this as a lost packet. If we later need to report which sensor failed, a status field will be added at the end in version 2.

## Rules

1. Never reorder the fields.
2. New fields are only added at the end. The backend expects exactly 18, so firmware, simulator and backend must all change together. Tell the whole team first and add a line to the change log below.
3. A packet without exactly 18 numeric fields is invalid. `nan` and `inf` are not numeric for this purpose. The backend counts an invalid packet and throws it away. It must never crash the backend.
4. `seq` goes up by 1 for every packet the ESP32 makes, whether or not it arrives.

## What the laptop works out (not in the packet)

| Value | Worked out from |
| --- | --- |
| Relative altitude | `press_pa`. The average of the first few seconds the backend sees counts as 0 m |
| Vertical speed | How fast the smoothed relative altitude changes |
| Total acceleration (g) | `ax`, `ay`, `az` combined, divided by 9.81 |
| Roll and pitch | `ax`, `ay`, `az` (the gyro rates help smooth them) |
| Heading (GPS) | Direction from the position about 1 s ago to the current one. Valid only when `fix` is 1 and `speed_mps` is above about 1 |
| Packet loss | Gaps in `seq` |
| Time since last packet | The laptop's own clock |

The BMI270 has no magnetometer, so yaw cannot be measured directly. That is why heading comes from GPS.

## To check on the real hardware

- [ ] Once the BMI270 is mounted: level gives `az` ≈ +9.81, nose up gives positive `ax`, right wing down gives positive `ay`. Fix any mismatch in the firmware.

## Change log

| Version | Date | Change |
| --- | --- | --- |
| 1 | 21 Nov 2026 | First version, 18 fields. Axes, no-fix behaviour and sensor failure behaviour decided |
