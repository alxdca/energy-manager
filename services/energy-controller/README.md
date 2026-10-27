# Energy Controller

The device controller for the Fronius GEN24 inverter and Wattpilot charger, in one workspace package. It monitors solar, grid and battery state, serves the dashboard and executes explicit battery commands with the existing control limits and supervision.

From the repository root:

```sh
cp services/energy-controller/.env.example services/energy-controller/.env
pnpm --filter energy-controller dev
```

Configure this service's `.env` before running. If migrating an existing installation, move its root `.env` here rather than replacing it. The default API address is `http://127.0.0.1:3001`; open `/dashboard` for the dashboard. Writes are disabled by default.

Battery SOC is read from the Solar API storage response or, when absent, the single active battery-bearing entry in `GetPowerFlowRealtimeData.fcgi` → `Body.Data.Inverters.*.SOC`. Some GEN24 installations expose SOC there while the separate Storage endpoint reports that no device exists. Invalid readings and ambiguous multiple batteries remain unknown. When Battery-Emulator scales SOC to a configured usable window, the inverter percentage describes that window rather than the physical pack SOC.

Live telemetry has no completed-response TTL cache. Each sequential status read fetches new power-flow and storage data from GEN24; simultaneous reads share in-flight requests. The former `API_STATUS_CACHE_SECONDS` setting has been removed. Reserve/configuration reads retain their existing safety behavior.

The running controller enforces a **16 kW gross-consumption ceiling** using fresh GEN24 `-Site.P_Load` (household including Tesla, excluding battery charging). Solar generation, grid export and battery discharge provide no extra consumption allowance. Before charging and at each five-second supervision tick, home-battery charging is capped at `max(0, min(requestedPower, 16000 - householdWatts))`. Zero uses a verified `[0,0]` window, and the original manual/automatic request, target and expiry survive curtailment. Solar-allowed holds use the same ceiling. Explicit runtime startup also supervises natural inverter operation with a renewable charging ceiling while still allowing natural discharge. Constructors and GET requests do not activate this runtime protection. `control.sitePowerProtection` exposes the latest allowance and errors; device faults remain latched and foreign register ownership is never overwritten.

Missing site measurements disable charging within the owned window. Communication delays, sampling, controller/inverter outages and uncontrollable household load mean software cannot promise an instantaneous 16 kW hardware interlock. AutomaticTesla pauses when fixed demand cannot fit after battery charging reaches zero. Finite inverter fallback still applies if supervision fails.

Automatic lease expiry attempts to release control five seconds before the deadline; the final window's deadline is set five seconds after 06:55/16:55 so that cleanup starts exactly at that cutoff. A failed automatic release retains its owner and expected register window, retries every five seconds until verified, and never replays charging. Normal mode confirms completion without another write; a changed foreign/manual window remains untouched. After successful automatic release, only a fresh complete safety read with a valid reserve and confirmed normal mode clears a recoverable expiration. Manual expirations and device faults remain latched for explicit recovery.

An automatic activation blocked by another controller also recovers only after a fresh complete safety read confirms normal mode and a valid reserve. Recovery performs no writes and waits for a new planner decision; it never clears a foreign control window. Manual ownership conflicts and device faults remain latched for explicit recovery.

Out-of-range battery power, SOC, reserve or rate scaling blocks activation and stops active control. Automatic interruptions can recover after a fresh complete safety read confirms valid values, healthy inverter state and normal mode. The error includes the rejected values for diagnosis. Manual interruptions and observed device faults still require explicit recovery.

Battery-Emulator is not a runtime dependency. The checked v13.2.0 installation serves HTML telemetry at `/live`; the upstream project also publishes JSON telemetry over an optional MQTT connection (`SOC` scaled, `SOC_real` physical). Any future fallback must keep those percentages distinct. See the upstream [HTTP routes](https://github.com/dalathegreat/Battery-Emulator/blob/main/Software/src/devboard/webserver/webserver.cpp) and [MQTT telemetry](https://github.com/dalathegreat/Battery-Emulator/blob/main/Software/src/devboard/mqtt/mqtt.cpp).

Build with `pnpm --filter energy-controller build`, then run `pnpm --filter energy-controller start`. Output lives in `services/energy-controller/dist/`. Service scripts also work from this directory, for example `pnpm test` and `pnpm restore-normal`.

Energy scheduling and future cross-device decisions belong to `energy-orchestrator`. See [operation and safety](../../docs/services/energy-controller/STATUS.md) and [troubleshooting](../../docs/services/energy-controller/TROUBLESHOOTING.md) for the controller's supported behavior.

## Wattpilot

The same process includes an independent local Wattpilot adapter. An unavailable inverter does not prevent charger monitoring, and charger errors do not interrupt GEN24 supervision. Both services require **Node 26+**, which provides the native WebSocket client used by the optional Wattpilot adapter.

Configure the controller's `.env` without replacing existing inverter settings:

```dotenv
WATTPILOT_URL=ws://192.168.1.2/ws
WATTPILOT_PASSWORD=your-local-device-password
WATTPILOT_CONTROL_ENABLED=false
# Required only when enabling writes; integer amperes per phase, at most 16 A.
WATTPILOT_MAX_CURRENT_AMPS=16
```

Use the charger’s local password. Do not commit it or put it in URLs. Configuration must include both URL and password; leaving both unset disables the integration. Classic Fronius Wattpilot protocol-v2 devices are supported. Wattpilot Flex/bcrypt authentication is explicitly unsupported.

| Endpoint | Contract |
| --- | --- |
| `GET /wattpilot/status` | Sanitized connection status, charger mode, vehicle presence, current setting, measured power and energy, timestamps and effective current limit. Unknown fields remain null; failed or stale observations are not reported as live. No writes. |
| `POST /wattpilot/set-control` with `{"mode":"pause"}` | Requests pause and confirms the charger state. |
| `POST /wattpilot/set-control` with `{"mode":"normal","currentAmps":10}` | Sets the mode and explicit integer per-phase current. Requires independent write opt-in and configured, device and cable limits. |
| `POST /wattpilot/set-control` with `{"mode":"eco","currentAmps":6}` | Selects the device’s eco mode within the same limits. Eco depends on the charger’s PV/pricing configuration; it does not prove solar-only operation. |

Commands use amperes rather than inferring watts from an unverified number of active phases. Manual normal/eco commands can additionally include `"phases":1` or `"phases":3`. When omitted, the charger’s existing phase setting is preserved. Pause accepts no phase field. The adapter reports `phaseMode` (`auto`, `1`, `3` or null) and `phaseSwitchingSupported` from the verified device `psm` property. This is the configured selection, not physical relay feedback. A changed selection pauses first, waits for new zero-power/not-charging/not-allowed telemetry, writes and verifies `psm` (1 for one phase, 2 for three), then applies current/mode and resumes. Missing confirmation, cancellation, connection loss or external setting changes stop the sequence without replaying commands or resuming. Internal charger switching delays remain authoritative; no fixed switching delay is assumed.

The broad-compatible `amp` setting is persistent on the charger; these endpoints are for occasional manual changes, not a rapid regulation loop. Partial commands and missing confirmations return errors; an unconfirmed write reports `outcome: "unknown"` and is never automatically replayed. Reads and reconnects never replay charging commands.

**Wattpilot has no verified device-side command expiry in this integration.** Shutdown attempts a confirmed pause for owned automatic sessions before disconnecting; manual settings remain manual. A lost controller process/host or unreachable device cannot guarantee a physical pause. GEN24's Modbus fallback/leases do not apply to Wattpilot. The adapter neither guarantees the installation-wide import ceiling nor enforces car SOC targets or tariffs. The orchestrator now displays charger state and proxies normal/eco/pause commands with a site-headroom check at startup; automatic car planning now uses the supervised endpoints below; a general continuous site optimizer remains future work.

Offline tests simulate authentication, multipart status, acknowledgements and failures. A physical charger, its firmware, cable limits, phases and eco configuration must still be verified during commissioning. Protocol references: [maintained Wattpilot client](https://github.com/ruaan-deysel/wattpilot-api/tree/main/src/wattpilot_api), [local API protocol](https://github.com/joscha82/wattpilot/blob/main/API.md), [Node native WebSocket](https://nodejs.org/download/release/v22.4.0/docs/api/globals.html#websocket).

## Automatic Wattpilot software leases

Automatic car policy stays in the orchestrator. This controller adds a durable ownership supervisor around the local Wattpilot adapter. Existing manual requests revoke the prior automatic epoch **before** their device action. An owned active charge is confirmed paused before a new manual charge can replace it; a failed transition retains cleanup rather than orphaning the old automatic command.

The journal defaults to `data/wattpilot-automation.json`, configurable with `WATTPILOT_AUTOMATION_STATE_PATH`. Preserve it across restarts and keep it private. It contains ownership/fencing data, never the local device password. A missing journal begins in manual mode; a corrupt/unwritable journal blocks new automatic control and is preserved for diagnosis. Manual pause remains available. Tests use explicit in-memory journals or isolated temporary files.

| Endpoint | Request |
| --- | --- |
| `POST /wattpilot/automation-epoch` | `{owner,expectedFence}` from fresh controller status. Requires a paused charger. Advances the durable fence and returns a new epoch. A stale fence returns conflict without changing authority. |
| `POST /wattpilot/automation-control` | `{owner,epoch,revision,expiresAt,mode:"normal"|"eco",currentAmps,phases?}`. Revision is a positive safe integer above the durable high-water mark; expiry is canonical UTC, future and at most 120 seconds ahead. |
| `POST /wattpilot/automation-renew` | `{owner,epoch,revision,expiresAt}`. Renews only the exact unchanged, verified active lease; it does not repeat mode/current/phase writes. An expired or stopping lease cannot be revived. |
| `POST /wattpilot/automation-stop` | `{owner,epoch,revision}`. Records the stop revision even before its activation arrives. It pauses only an owned revision no newer than that stop; a late stop cannot affect a newer job. |

`GET /wattpilot/status` includes `automation` with owner, epoch, active revision, `lastRevision`, expiry, fence, manual/stopping state and a sanitized error. Passive status/imports do not start control loops or issue setting writes. The normal server explicitly starts supervision; an explicit automatic RPC also starts it after request validation. No operation replays an uncertain charging activation.

Automatic activation intent remains owned after an unknown result, even when the adapter cache still shows a pre-resume pause and zero power. Cleanup sends an ordered compensating pause, refreshes a new read-only full device snapshot after its acknowledgement, and requires a fresh stopped-power/connection observation before releasing the durable intent. Missing proof or a late busy observation retains cleanup and its retries across restart and manual handoff. Journal commits sync both the file and its parent directory.

The supervisor independently checks ownership and state every five seconds, with a separate deadline timer that aborts an in-flight activation at lease expiry. Expiry and cleanup issue only conditional pause operations. Failed/unconfirmed cleanup remains pending and retries after connection recovery. Restart reconciles and stops the previously recorded session, including a recorded activation that never acknowledged; it does not replay that activation. External mode/current/phase changes revoke the old epoch and are preserved. An identical external write cannot be distinguished from an unchanged owned setting because the device exposes no ownership token.

**These are software leases, not a Wattpilot hardware watchdog.** A live controller can stop a charge when the orchestrator fails. A killed controller, failed host or unreachable charger can leave the last setting active until recovery; an exact physical cutoff cannot be guaranteed under those failures. `deviceExpirySupported:false` makes that limitation explicit. The caller must bound each lease to its actual tariff/departure cutoff.

During an uncertain activation, the device has no ownership token that distinguishes an external app’s write from a delayed continuation of our own command. Recovery may issue a compensating pause in that ambiguity. Local manual API actions are durably fenced; confirmed steady-state external changes revoke automation and are preserved.

## Bounded natural battery supply

`POST /inverter/automation-supply` accepts `{owner,expiresAt,maxPowerWatts,minimumSocPercent,automationFence,authorizationExpiresAt}`. Read the top-level `automationFence:{bootId,generation}` from `GET /inverter/control-status` and include it unchanged with the request. The serialized controller checks it before any actuation; an obsolete fence returns 409 without writes. Each accepted transition or renewal consumes the fence, as do local floor/error holds, expiry and manual control. A controller restart generates a new boot ID. This prevents delayed old supply permission from reopening a spent solar quota after the battery has recharged. A rejected request requires a fresh plan and status, not a retry with a substituted fence.

`authorizationExpiresAt` is a separate canonical UTC source-permission deadline, future and at most ten seconds away at API entry. The caller binds it to the source SOC observation used for its energy budget. It is checked again inside the serialized boundary before changing the current window after the fresh safety read, and after the final raw Modbus ownership/safety reads immediately before the first register write. This initial permission deadline is not retained in the ongoing session. Expiry before mutation returns 409 without writes or consuming the fence. If it expires during owned preflight, the controller commits an owned hold and returns 409 while preserving that hold. The control lease below can remain valid for 16 minutes; it does not extend permission to activate an old energy budget.

The owner and canonical UTC lease follow the existing automatic battery contract (at most 16 minutes). The power ceiling must be positive, no more than the configured ceiling, the verified SunSpec capability or 7 kW. A new supply floor must be finite, protect the installed inverter reserve and remain below current verified SOC. Unknown SOC/capability refuses activation. The caller, not the controller, must prove solar provenance and the energy protected for the next expensive period.

Supply applies a **permissive discharge-only power window**: charge input limit **0**, discharge output limit **0…maxPowerWatts**. Zero discharge is allowed. This differs from the existing negative manual setpoint, whose negative input bound requests forced discharge. Battery charging is forbidden while the supply window is active, including grid energy that must not be counted as solar assistance.

Control status exposes `automationMode:"supply"`, negative `watts` representing its maximum discharge permission, and `minimumSocPercent`. `GET /inverter/control-status` advertises `automationSupply:true`. The local five-second supervisor changes an owned supply window directly to an owned hold when SOC reaches the greater of the requested floor and installed reserve. It never changes the persistent reserve. Charge/supply/hold transitions involving supply narrow the live bounds safely before opening the new direction and do not briefly release unrestricted normal mode. Renewing the same window keeps ownership and existing finite safety limits.

A tighter quota or raised reserve also yields to hold. Supply-origin holds respect smaller configured power ceilings; existing general automatic holds keep their 6 kW contract. If supervision fails, the controller attempts an owned hold where device state is still verifiable. A device/transport failure can prevent that write, and lease expiry retains the documented GEN24 normal-operation fallback; it is not a guarantee of a persistent SOC floor after all controllers are gone. Manual control and foreign ownership remain higher priority.

Automatic Wattpilot leases support normal and native Eco. An unchanged, observed, configured-safe current can be preserved in Eco without a known cable ceiling when unplugged, provided no phase change is requested. This path does not rewrite the current and still aborts on external setting changes. Any changed current/phase or normal-mode request retains the verified device/cable-limit checks. Native Eco is a charger mode, not proof of exclusive solar energy.

## Read-only energy counters

`GET /system/energy-counters` exposes fresh GEN24 cumulative PV DC and household AC energy in Wh, plus battery SOC with actual component timestamps. PV uses the two PV-string counters. Household energy is net inverter AC production/consumption plus grid import/export at the primary grid meter; battery charging is therefore not mislabeled as household demand. The endpoint validates source identities, units, component freshness and native monotonic totals for downstream reset detection. It sends no control commands. Observation selection and quarter-energy differencing happen in the orchestrator; this endpoint never averages readings.
