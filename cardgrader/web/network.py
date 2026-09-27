"""Helpers for opening the app from a phone on the same network."""

from __future__ import annotations

import socket

import cv2


def lan_addresses() -> list[str]:
    """Best-effort list of this machine's private IPv4 addresses."""
    found: list[str] = []
    try:  # the interface the OS would route external traffic through (no packet is sent)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    private = [ip for ip in dict.fromkeys(found) if not ip.startswith("127.")]
    return private


def qr_svg(text: str, module: int = 6, border: int = 3) -> str:
    """Render ``text`` as a QR code SVG using OpenCV's encoder."""
    matrix = cv2.QRCodeEncoder.create().encode(text)
    # One pixel per module, no quiet zone; dark modules are 0.
    size = matrix.shape[0]
    total = (size + 2 * border) * module
    rects = [
        f'<rect x="{(x + border) * module}" y="{(y + border) * module}" width="{module}" height="{module}"/>'
        for y in range(size)
        for x in range(size)
        if matrix[y, x] < 128
    ]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" shape-rendering="crispEdges">'
        f'<rect width="100%" height="100%" fill="#fff"/><g fill="#000">{"".join(rects)}</g></svg>'
    )
