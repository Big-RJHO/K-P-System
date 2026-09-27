"""Run the grading web app: ``python -m cardgrader.web [--lan] [--port P]``."""

from __future__ import annotations

import argparse
import os


def main() -> None:
    import uvicorn

    from .network import lan_addresses

    parser = argparse.ArgumentParser(description="Card grading estimator (PSA / BGS / CGC / TAG)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--lan",
        action="store_true",
        help="listen on your local network so an iPhone on the same Wi-Fi can open the app",
    )
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else args.host
    os.environ["CARDGRADER_PORT"] = str(args.port)
    os.environ["CARDGRADER_LAN"] = "1" if host in ("0.0.0.0", "::") else "0"
    print(f"\n  Card Grading Lab: http://127.0.0.1:{args.port}")
    if os.environ["CARDGRADER_LAN"] == "1":
        for ip in lan_addresses():
            print(f"  On your iPhone (same Wi-Fi): http://{ip}:{args.port}")
    else:
        print("  Tip: start with --lan to open it from your iPhone")
    print()
    uvicorn.run("cardgrader.web.app:app", host=host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
