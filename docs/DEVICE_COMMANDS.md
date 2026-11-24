# Device commands

One MCP tool, `device(surface, op, args?, ttl_s?, wait?)`, runs any op the surface's device has registered, without a bus tool per feature. The bus treats `op` and `args` as opaque. Route: `POST /api/v1/surface-publish/:surface/command` (body `{agent_id, op, args?, ttl_s?, wait?}`), authorised like the other publish routes: the agent must be in the surface's `publishers`.

## Frames

Bus to device, on the existing socket (`/api/v1/surface/ws` or `/api/v1/intercom/ws`; a BLE relay passes it through unchanged):

    {"type":"command","id":"<uuid>","op":"pomodoro","args":"start 25 5 15","ttl_s":120}

`args` is omitted, a string or any JSON value. `ttl_s` defaults to 120 (1 to 3600).

Device to bus:

    {"type":"command_result","id":"<same id>","ok":true,"data":{...}}
    {"type":"command_result","id":"<same id>","ok":false,"reason":"unknown_op|bad_args|expired|busy|failed","data":"<hint>"}

Hello (re-sent on every connection): `{"type":"hello","token":...,"ops":[{"op":"pomodoro","usage":"start [focus] | pause | stop"}]}`. A connected device can refresh the list with `{"type":"capabilities","ops":[...]}`. Up to 64 ops; `usage` is cut at 200 characters.

A `command_result` is accepted from any ready client of the surface (read-only devices included: it is an answer, not a write); one whose id is unknown, late or from another surface is logged and dropped.

## Bus behaviour

- `offline`: no ready client on the surface. Answered at once; nothing is queued. Several clients: the newest one that declared `ops` gets the command, else the newest ready client.
- `timeout`: no `command_result` within 10 s. `wait: false` returns `{ok:true,data:{sent:true,id}}` without waiting; the later result is only logged.
- `help`: answered on the bus from the latest hello's ops (kept after the device disconnects), plus the bus ops below. `args` = an op name returns that op's `{op, usage}`; an unknown name answers `unknown_op`.
- Logs (`device_command`, `device_command_result`, `device_command_done`): id, surface, op, args (first 200 characters), outcome. Result data is not logged.

## Bus ops (phase 2)

Run by the bus through the existing publish routes (same validation, limits, ownership and publisher checks); they never reach the device. `args` is a JSON object (or a JSON string).

| op | args | same as |
|---|---|---|
| `event.publish` | `{id, title, ...}` | `surface_publish_event` |
| `event.remove` | `{id, reason?}` | `surface_remove_event` |
| `widget.write` | `{id, type, data}` | `surface_write_widget` |
| `widget.remove` | `{id}` | `surface_remove_widget` |
| `asset.upload` | `{data_base64, content_type}` | `surface_upload_asset` (needs the asset store) |

A validation failure answers `{ok:false, reason:"bad_args", data:"<message>"}`; other HTTP failures answer `forbidden` (403), `unknown_surface` (404) or `failed`. The old tools are unchanged.
