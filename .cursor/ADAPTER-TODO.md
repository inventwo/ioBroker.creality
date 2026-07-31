# Adapter TODO — ioBroker.creality

Status: **prototype script works** (`scripts/iobroker-print-status.js`). Full adapter not scaffolded yet.

## Decision log

| Topic | Decision |
|-------|----------|
| Name | `iobroker.creality` |
| Primary device | SPARKX i7 (only hardware available for testing) |
| Not | SPARKX-only name, not “klipper-lite” |
| Scaffold | Prefer **`@iobroker/create-adapter`** (same as enpal/autodarts), then port script logic |
| Author | skvarel / inventwo |

## Phase 0 — validation (user, ~1–2 days)

- [ ] Run prototype script in production VIS
- [ ] Confirm pause / resume / stop / both LEDs / CFS / temps / ETA
- [ ] Note any missing datapoints for v1

## Phase 1 — scaffold

- [ ] Run create-adapter into this repo (or generate then merge with `scripts/` + `.cursor/`)
- [ ] Suggested create-adapter choices (align with inventwo):
  - JavaScript, jsonConfig admin, ESLint official, release-script, Node 20/22+
  - type: hardware, connection: local, dataSource: poll (+ push WS)
  - connection indicator: yes
- [ ] Keep `scripts/iobroker-print-status.js` as reference until feature parity
- [ ] Add `.create-adapter.json` for reproducibility

## Phase 2 — port features (v0.1)

- [ ] Config: host, moonrakerPort, crealityWsPort, pollInterval, apiKey
- [ ] Moonraker poll → print + temp + fans + CFS states
- [ ] Creality WS → light + pause/resume/stop + sync `lightSw`
- [ ] `info.connection` traffic light
- [ ] README (EN) + DE docs if matching inventwo layout
- [ ] Package/integration tests (mocked APIs)

## Phase 3 — nice-to-have (after v0.1)

- [ ] Device info: model, firmware/Klipper/Moonraker versions
- [ ] Print hours / history stats (Moonraker history / Creality telemetry)
- [ ] Optional layer current/total
- [ ] Capability detection (hide CFS if no `box`)
- [ ] Document untested models (K1/K2/…) as community feedback

## Explicit non-goals (v1)

- Full Klipper object mirror (use `klipper-moonraker` for that)
- Creality Cloud account integration
- Multi-printer discovery beyond one host per instance (multi-instance OK)

## Logging (offline)

- Unreachable printer: one **info** log on transition offline, one **info** on back online
- Documented from prototype flood (`EHOSTUNREACH` every 5s) — must not repeat in adapter
