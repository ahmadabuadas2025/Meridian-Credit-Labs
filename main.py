"""Meridian Credit Labs - class demo loan-review engine.

    python main.py            run the console demo (same as `python main.py demo`)
    python main.py serve      start the web app on http://127.0.0.1:8000 (localhost only)
    python main.py serve --port 8080
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from loan_review import pipeline
from loan_review.store import Store

DATA_DIR = Path(__file__).resolve().parent / "data"


def demo() -> None:
    print("Meridian Credit Labs - loan review demo (fictional data, mock models)\n")
    with tempfile.TemporaryDirectory() as tmp:
        store = Store(tmp)
        results = pipeline.seed_samples(store)
        rows = [(r["application"]["applicant_name"], str(r["risk"]["score"]), f"{r['risk']['dti']:.1%}",
                 r["auto_decision"]["outcome"], r["auto_decision"]["reason"]) for r in results]
        headers = ("applicant", "risk", "DTI", "outcome", "reason")
        widths = [max(len(h), *(len(row[i]) for row in rows)) for i, h in enumerate(headers[:4])]
        fmt = "  ".join(f"{{:<{w}}}" for w in widths) + "  {}"
        print(fmt.format(*headers))
        print("  ".join("-" * w for w in widths) + "  " + "-" * 40)
        for row in rows:
            print(fmt.format(*row))

        print("\nFailure case (R0 - invalid input):")
        bad = {**pipeline.load_samples()[0], "applicant_name": "Invalid Example", "loan_amount": -500}
        try:
            pipeline.submit_application(store, bad)
        except ValueError as e:
            print(f"  loan_amount=-500 -> ValueError: {e}")

        print(f"\n{len(store.events())} audit events written, "
              f"{len(store.read_jsonl(store.outbox_path))} mock notices in the outbox.")
    print("\nRun 'python main.py serve' to open the web app.")


def serve(argv: list[str]) -> None:
    from loan_review.server import make_server

    port = 8000
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    store = Store(DATA_DIR)
    if not store.list_applications():
        pipeline.seed_samples(store)
    server = make_server(store, "127.0.0.1", port)
    print(f"Meridian Credit Labs demo running at http://127.0.0.1:{port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


def main(argv: list[str]) -> int:
    command = argv[0] if argv else "demo"
    if command == "demo":
        demo()
    elif command == "serve":
        serve(argv[1:])
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
