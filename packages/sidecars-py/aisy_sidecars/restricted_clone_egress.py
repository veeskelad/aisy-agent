"""One-shot exact-target HTTP CONNECT gateway for restricted public clone."""

from __future__ import annotations

import ipaddress
import json
import os
import selectors
import socket
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import NoReturn

MAX_HEADER_BYTES = 8 * 1024
MAX_IPS = 16
CONNECT_TIMEOUT_SECONDS = 10.0
IDLE_TIMEOUT_SECONDS = 30.0
LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 3128


class GatewayFailure(Exception):
    """Redacted policy/protocol failure."""


def _fail() -> NoReturn:
    raise GatewayFailure("EGRESS_DENIED")


def _required(env: Mapping[str, str], key: str, maximum: int) -> str:
    value = env.get(key)
    if value is None or not value or len(value.encode("utf-8")) > maximum or "\x00" in value:
        _fail()
    return value


@dataclass(frozen=True)
class GatewayPolicy:
    hostname: str
    addresses: tuple[str, ...]
    max_tunnel_bytes: int

    @classmethod
    def from_environment(cls, env: Mapping[str, str]) -> GatewayPolicy:
        hostname = _required(env, "AISY_EGRESS_HOST", 253).lower()
        if any(ord(character) < 33 or ord(character) == 127 for character in hostname):
            _fail()
        try:
            hostname = str(ipaddress.ip_address(hostname))
        except ValueError:
            pass
        raw_addresses = _required(env, "AISY_EGRESS_IPS_JSON", 2048)
        try:
            decoded = json.loads(raw_addresses)
        except (TypeError, ValueError):
            _fail()
        if not isinstance(decoded, list) or not 1 <= len(decoded) <= MAX_IPS:
            _fail()
        addresses: list[str] = []
        for value in decoded:
            if not isinstance(value, str):
                _fail()
            try:
                parsed = ipaddress.ip_address(value)
            except ValueError:
                _fail()
            if not parsed.is_global:
                _fail()
            canonical = str(parsed)
            if canonical in addresses:
                _fail()
            addresses.append(canonical)
        raw_maximum = _required(env, "AISY_EGRESS_MAX_BYTES", 32)
        try:
            maximum = int(raw_maximum, 10)
        except ValueError:
            _fail()
        if not 1_048_576 <= maximum <= 42_949_672_960:
            _fail()
        return cls(hostname=hostname, addresses=tuple(addresses), max_tunnel_bytes=maximum)


def _authority(value: str) -> tuple[str, int]:
    if value.startswith("["):
        closing = value.find("]")
        if closing < 0 or value[closing + 1 : closing + 2] != ":":
            _fail()
        host = value[1:closing]
        port_text = value[closing + 2 :]
    else:
        if value.count(":") != 1:
            _fail()
        host, port_text = value.rsplit(":", 1)
    try:
        port = int(port_text, 10)
    except ValueError:
        _fail()
    if not host or port != 443:
        _fail()
    try:
        normalized = str(ipaddress.ip_address(host))
    except ValueError:
        normalized = host.lower()
    return normalized, port


def parse_connect_request(data: bytes, policy: GatewayPolicy) -> None:
    if len(data) > MAX_HEADER_BYTES or not data.endswith(b"\r\n\r\n"):
        _fail()
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        _fail()
    lines = text.split("\r\n")
    if not lines or len(lines[0].split(" ")) != 3:
        _fail()
    method, target, version = lines[0].split(" ")
    if method != "CONNECT" or version != "HTTP/1.1":
        _fail()
    hostname, port = _authority(target)
    if hostname != policy.hostname or port != 443:
        _fail()
    seen_host = False
    for line in lines[1:]:
        if line == "":
            continue
        if ":" not in line:
            _fail()
        name, value = line.split(":", 1)
        if not name or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-" for character in name):
            _fail()
        if name.lower() == "proxy-authorization":
            _fail()
        if name.lower() == "host":
            host, host_port = _authority(value.strip())
            if host != policy.hostname or host_port != 443 or seen_host:
                _fail()
            seen_host = True
    if not seen_host:
        _fail()


Connector = Callable[[str, int, float], socket.socket]


def connect_reviewed(policy: GatewayPolicy, connector: Connector | None = None) -> socket.socket:
    connect = connector or (lambda address, port, timeout: socket.create_connection((address, port), timeout))
    for address in policy.addresses:
        try:
            return connect(address, 443, CONNECT_TIMEOUT_SECONDS)
        except OSError:
            continue
    _fail()


def relay(client: socket.socket, upstream: socket.socket, maximum: int) -> int:
    selector = selectors.DefaultSelector()
    sockets = (client, upstream)
    for item in sockets:
        item.settimeout(IDLE_TIMEOUT_SECONDS)
        selector.register(item, selectors.EVENT_READ)
    transferred = 0
    try:
        while True:
            events = selector.select(IDLE_TIMEOUT_SECONDS)
            if not events:
                _fail()
            for key, _mask in events:
                source = key.fileobj
                destination = upstream if source is client else client
                chunk = source.recv(64 * 1024)
                if not chunk:
                    return transferred
                transferred += len(chunk)
                if transferred > maximum:
                    _fail()
                destination.sendall(chunk)
    finally:
        selector.close()


def _read_header(client: socket.socket) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = client.recv(min(2048, MAX_HEADER_BYTES + 1 - total))
        if not chunk:
            _fail()
        total += len(chunk)
        if total > MAX_HEADER_BYTES:
            _fail()
        chunks.append(chunk)
        combined = b"".join(chunks)
        marker = combined.find(b"\r\n\r\n")
        if marker >= 0:
            if marker + 4 != len(combined):
                _fail()
            return combined


def serve(policy: GatewayPolicy) -> NoReturn:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((LISTEN_HOST, LISTEN_PORT))
        listener.listen(8)
        while True:
            client, _peer = listener.accept()
            with client:
                client.settimeout(IDLE_TIMEOUT_SECONDS)
                try:
                    header = _read_header(client)
                    parse_connect_request(header, policy)
                    upstream = connect_reviewed(policy)
                    with upstream:
                        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                        relay(client, upstream, policy.max_tunnel_bytes)
                except (GatewayFailure, OSError):
                    try:
                        client.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                    except OSError:
                        pass


def healthcheck() -> int:
    try:
        with socket.create_connection(("127.0.0.1", LISTEN_PORT), 1.0):
            return 0
    except OSError:
        return 1


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    if sys.argv[1] == "healthcheck":
        return healthcheck()
    if sys.argv[1] != "serve":
        return 2
    try:
        policy = GatewayPolicy.from_environment(os.environ)
    except GatewayFailure:
        return 2
    serve(policy)


if __name__ == "__main__":
    raise SystemExit(main())
