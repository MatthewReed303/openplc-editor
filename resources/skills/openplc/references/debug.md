# Debugging

A debug session is long-lived; each command is a one-shot that attaches to it.

```sh
openplc-cli debug open <project> --target <board> (--host <address> | --port <serial>)
openplc-cli debug list
openplc-cli debug list-vars
openplc-cli debug read --session <id>
openplc-cli debug force <variable> <value>
openplc-cli debug unforce <variable>
openplc-cli debug start | stop
openplc-cli debug cold-restart
openplc-cli debug watch | poll | unwatch
openplc-cli debug stats [--reset]
openplc-cli debug close --session <id> | --all
```

`debug open` returns a `session_id`. A session closes itself after 30 minutes
idle.

`debug read` and `force` reach any variable in the program's debug map —
`debug list-vars` prints the whole list. A variable's `debug: true` flag ticks it
into the EDITOR's chart and is not needed here.

Paths use a colon between the POU and the variable: `PlantLogic:levelPct`, and
`Config0:gPump` for a resource global. Members and array elements use dots and
brackets from there — `AnalogChain:counter.Cfg.Trend[0]`.

## Warm start and cold restart

`start` is a warm restart: RETAIN variables keep the values they had when the
PLC stopped, the rest start from their initial values (IEC 61131-3 6.5.6.1).
`cold-restart` sets every variable, RETAIN included, to its initial value and
replaces the stored retained values with them, then runs (Figure 9 rule 4).
Runtimes and boards accept it from STOP only, so the command stops the PLC
first. A board whose firmware predates the cold restart just stays stopped,
and the command says so: upload a build from this editor, or `start` to resume
with the retained values.

## A board in RTOS mode

`debug stats` shows each task's timing: period, releases, overruns (releases
skipped because the task was still running), scan, cycle and latency times,
stack left, and `STUCK <us>` for a task inside one scan for more than twice its
period (20 ms at least). `--reset` starts a new window. A board running the
single loop answers `not_supported`.

A write or force of a variable whose task is stuck mid-scan answers *busy*
(`The PLC is busy: ...`) until that scan ends: retry it. A global is written
under its own lock and is busy only while a task holds it for more than 100 ms.
Reads always answer; a stuck task's variables are read as they stand.

## Credentials

Targets reached over a runtime API need them; a board flashed over USB does not.

```sh
--credentials user:pass          # or --user / --password
OPENPLC_CREDENTIALS=user:pass    # or OPENPLC_USER + OPENPLC_PASSWORD
```

Prefer the environment form: a flag lands in shell history and job logs.

See `docs/CLI.md` in the editor repository for the session protocol and the full
flag list.

## Forcing an enumerated variable

An enumeration is published as `INT` and a data type with named values as its
base type (`USINT` for `Status : USINT (...)`); force it with the member's
number, or by name in the editor. A library built before STruC++ stored
enumerations as INT still holds them as 4 bytes, and forcing one of its
enumerations does not take until the library is rebuilt.

An element of an `ARRAY OF` an enumeration, alias or subrange declared in a POU
or as a global (`colors : ARRAY[1..3] OF Color`) is stored without a forcing
wrapper: it is watched like any variable, but it cannot be forced. Inside a named
ARRAY type or a STRUCT, alias and subrange elements are stored the same way,
while enumeration elements keep their wrapper and force. `debug list-vars` marks
each one that cannot be forced `not forceable (array element)` (`raw` and
`readOnly` in `--json`), and `debug force` refuses it.
