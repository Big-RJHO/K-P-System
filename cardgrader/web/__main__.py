"""Run the grading web app: ``python -m cardgrader.web [--host H] [--port P]``."""

from __future__ import annotations

import argparse


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="Card grading estimator (PSA / BGS / CGC / TAG)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    args = parser.parse_args()
    uvicorn.run("cardgrader.web.app:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
