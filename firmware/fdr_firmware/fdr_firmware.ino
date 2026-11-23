// fdr_firmware.ino - UAV flight data recorder firmware
// PART 1: sensors, units, axis mapping, gyro calibration.

#include <Wire.h>
#include <math.h>
#include <Adafruit_BME280.h>
#include "SparkFun_BMI270_Arduino_Library.h"

// ===== Settings =====
const uint8_t BME_ADDR = 0x76;
const uint8_t BMI_ADDR = 0x69;
const float GRAVITY = 9.81f;          // g -> m/s^2
const int GYRO_CAL_SAMPLES = 200;     // 200 x 10 ms = 2 seconds

Adafruit_BME280 bme;
BMI270 imu;

// Gyro resting error, in the CHIP's own axes (before mapping)
float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;

// One full set of readings, in packet units and drone axes
struct Reading {
  float ax, ay, az;          // m/s^2
  float gx, gy, gz;          // deg/s
  float temp_c, press_pa, hum_pct;
};

// ===== The ONE place where chip axes become drone axes =====
// Input: a vector as the chip reports it (cx, cy, cz).
// Output: the same vector in drone axes: x = nose, y = left wing, z = up.
// It is used for BOTH the accelerometer and the gyro.
// Fix wrong signs here after the hand-tilt tests. Change TWO axes together
// (a rotation); flipping only one makes a mirror image and the gyro tests fail.
void mapAxes(float cx, float cy, float cz, float &x, float &y, float &z) {
  x = cx;    // drone x (nose)
  y = cy;    // drone y (left wing)
  z = cz;    // drone z (up)
}

// ===== Sensor start-up (retries forever, prints the error) =====
void startBme() {
  while (!bme.begin(BME_ADDR)) {
    Serial.println("ERROR: BME280 not found at 0x76. Check wiring. Retrying in 2 s...");
    delay(2000);
  }
  Serial.print("BME280 OK, chip ID 0x");
  Serial.println(bme.sensorID(), HEX);
  if (bme.sensorID() != 0x60) {
    Serial.println("WARNING: chip ID is not 0x60. This may be a BMP280 (no humidity).");
  }
}

void startImu() {
  while (imu.beginI2C(BMI_ADDR, Wire) != BMI2_OK) {
    Serial.println("ERROR: BMI270 not found at 0x69. Check wiring. Retrying in 2 s...");
    delay(2000);
  }
  Serial.println("BMI270 OK");
}

// ===== Gyro calibration: board must be still =====
void calibrateGyro() {
  bool done = false;
  while (!done) {
    Serial.println("Keep the board still for 2 seconds...");
    float sx = 0, sy = 0, sz = 0;
    int good = 0;
    for (int i = 0; i < GYRO_CAL_SAMPLES; i++) {
      if (imu.getSensorData() == BMI2_OK) {
        sx += imu.data.gyroX;
        sy += imu.data.gyroY;
        sz += imu.data.gyroZ;
        good++;
      }
      delay(10);
    }
    if (good >= GYRO_CAL_SAMPLES * 3 / 4) {
      gyroBiasX = sx / good;
      gyroBiasY = sy / good;
      gyroBiasZ = sz / good;
      done = true;
    } else {
      Serial.println("ERROR: too many failed IMU reads during calibration. Trying again...");
    }
  }
  Serial.printf("Gyro bias (deg/s): %.2f %.2f %.2f\n", gyroBiasX, gyroBiasY, gyroBiasZ);
}

// ===== Read everything once. Returns false if ANY value is bad. =====
bool readSensors(Reading &r) {
  if (imu.getSensorData() != BMI2_OK) return false;

  // The library gives acceleration in g and rotation in deg/s
  float cax = imu.data.accelX * GRAVITY;
  float cay = imu.data.accelY * GRAVITY;
  float caz = imu.data.accelZ * GRAVITY;
  float cgx = imu.data.gyroX - gyroBiasX;
  float cgy = imu.data.gyroY - gyroBiasY;
  float cgz = imu.data.gyroZ - gyroBiasZ;

  mapAxes(cax, cay, caz, r.ax, r.ay, r.az);
  mapAxes(cgx, cgy, cgz, r.gx, r.gy, r.gz);

  r.temp_c   = bme.readTemperature();
  r.press_pa = bme.readPressure();      // already in Pa, do not divide
  r.hum_pct  = bme.readHumidity();

  // Every number must be a real number (never nan or inf)
  float all[] = { r.ax, r.ay, r.az, r.gx, r.gy, r.gz, r.temp_c, r.press_pa, r.hum_pct };
  for (float v : all) {
    if (!isfinite(v)) return false;
  }
  // Datasheet limits of the chip: a value outside means a failed read
  if (r.temp_c < -40 || r.temp_c > 85) return false;
  if (r.press_pa < 30000 || r.press_pa > 110000) return false;
  if (r.hum_pct < 0 || r.hum_pct > 100) return false;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=== FDR firmware: Part 1 (sensors) ===");

  Wire.begin(21, 22);
  Wire.setClock(100000);

  startBme();
  startImu();
  calibrateGyro();
  Serial.println("Ready.");
}

void loop() {
  static unsigned long nextPrint = 0;
  unsigned long now = millis();
  if ((long)(now - nextPrint) >= 0) {
    nextPrint = now + 200;               // 5 prints per second, easy to read
    Reading r;
    if (readSensors(r)) {
      float mag = sqrt(r.ax * r.ax + r.ay * r.ay + r.az * r.az);  // bench check only
      Serial.printf("ax=%6.2f ay=%6.2f az=%6.2f | gx=%7.1f gy=%7.1f gz=%7.1f | mag=%5.2f | T=%.1f P=%.0f H=%.1f\n",
                    r.ax, r.ay, r.az, r.gx, r.gy, r.gz, mag, r.temp_c, r.press_pa, r.hum_pct);
    } else {
      Serial.println("READ FAILED (a packet would be skipped here)");
    }
  }
}