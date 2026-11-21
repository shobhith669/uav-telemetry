import socket

HOST = "127.0.0.1"
PORT = 5005

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((HOST, PORT))

print(f"Listening for UDP packets on {HOST}:{PORT} ... (Ctrl+C to stop)")

try:
    while True:
        data, addr = sock.recvfrom(4096)
        line = data.decode("utf-8", errors="replace").strip()
        print(f"[{addr[0]}:{addr[1]}] {line}")
except KeyboardInterrupt:
    print("\nStopped listener.")
finally:
    sock.close()