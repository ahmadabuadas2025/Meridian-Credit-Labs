# AI usage

This project was built with **Claude Code** (Anthropic, Claude Opus 5.5) working in this folder.
I wrote the brief. The assistant wrote the code, ran the tests and the browser checks, and reported back.

## Key prompts I gave

1. **The main build brief** (summarised). "Build a small, working, explainable loan-review
   system with a polished website for Meridian Credit Labs, a fictional digital lender. Fictional
   data only, with every mock labelled."
   - Constraints: Python 3.10+ standard library only, no frameworks or build step, and plain
     HTML/CSS/JS served by `http.server`. `python main.py` runs a demo, `python -m unittest -v`
     must pass, and `python main.py serve` binds to localhost. No git commit or push, no real
     personal data, and no `cgi` module.
   - Architecture: one module per component, mirroring intake → document extraction → risk
     scoring → lending rules → human underwriting → decision record → notification.
   - Toy rules R0-R7 in a fixed order, all thresholds in one `THRESHOLDS` dict, a documented
     deterministic mock risk formula, write-once records plus an append-only audit log, and
     underwriter decisions only on REVIEW cases, with a name and note, never overwriting the
     automated decision.
   - JSON API endpoints including 400/404 handling and no stack traces.
   - Website: a premium fintech landing page with scroll-driven animation (CSS
     `animation-timeline` plus an IntersectionObserver fallback, and reduced motion
     respected), a multi-step applicant dashboard with scenario quick-fills and an inbox, and an
     underwriter console with KPIs, an SVG chart, component status, a queue, and a detail drawer.
     Responsive to 375px, accessible, no console errors.
   - Use a design skill if available, and Higgsfield for 2-3 abstract video loops under 3 MB each.
   - Specific tests, README contents, this file, and `.gitignore`.
   - Build order with a verification checkpoint after each stage.

## What the assistant built

- `loan_review/`: the engine (models, intake, extraction, risk, rules, underwriting, store, notify, a thin `pipeline.py` orchestrator, and `server.py`).
- `main.py` with the console demo and `serve` command. `test_main.py` has 23 tests, including an API smoke test.
- `sample_data/`: 7 fictional applicants (one per rule R1-R7) and 20 fictional `.txt` documents.
- `web/`: three pages, a shared CSS token system with light and dark themes, vanilla JS, and two Higgsfield-generated abstract loops re-encoded to under 600 KB.
- `README.md` (with real console output and screenshots), this file, and `.gitignore`.

How it was checked:

- The demo and all tests were run until green.
- Every endpoint was exercised with curl, including 400, 404 and path traversal.
- Playwright screenshots were taken at 1440px and 375px, and the pages were checked for console errors and horizontal overflow.
- Each quick-fill scenario was run end to end.
- One underwriter decision was made through the UI, and `data/audit_log.jsonl` was checked for the new event.
- Reduced motion, the scroll-animation fallback, and keyboard focus were tested.

Issues found and fixed while checking:

- `display` rules were overriding the `hidden` attribute, so every form step showed at once.
- Global tabular figures were spacing out punctuation in headings.
- The rule-trace wording was misleading ("R4 decided: document income matches stated income").
- A validator check failed for the dark-mode chart colors.

## What I changed or verified

> Fill this in before submitting.

- [ ] Ran `python main.py` myself. Output looked like: _..._
- [ ] Ran `python -m unittest -v`. Result: _..._
- [ ] Walked through the website: _..._
- [ ] Code I read line by line and understand: _..._
- [ ] Things I changed by hand: _..._
- [ ] Things I would do differently / questions I still have: _..._
- [ ] Confirmed there is no real personal data, secrets or tokens in the repo: _..._
