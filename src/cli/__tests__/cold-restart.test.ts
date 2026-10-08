/**
 * Cold restart (IEC 61131-3 Figure 9 rule 4): every variable, RETAIN included,
 * back to its initial value, the stored retained values replaced, then RUN.
 *
 * On a board it is FC 0x4b with request byte 0x03, accepted from STOP only
 * (status 0x88 while running), so the control stops the PLC first, as it does
 * on the Linux runtime. A firmware older than the cold restart reads 0x03 as
 * STOP and stays stopped; the control checks the state afterwards and says so
 * rather than claiming a restart that never happened.
 */
import {
  buildPlcSetStateRequest,
  parsePlcSetStateResponse,
  PLC_REQUEST_COLD_RESTART,
  type PlcSetStateRequest,
} from '../../backend/shared/debug/modbus-pdu'
import type { DeviceDebugChannel } from '../../backend/shared/debug/types'
import { ModbusDebugResponse, ModbusFunctionCode, PlcRuntimeState } from '../../backend/shared/simulator/types'
import { channelPlcControl } from '../session/session-core'

/** A board: RUN/STOP take effect at once; `firmware` decides what 0x03 does. */
function fakeBoard(firmware: 'current' | 'old', initial = PlcRuntimeState.RUNNING) {
  let state = initial
  const requests: PlcSetStateRequest[] = []
  const channel = {
    setPlcState: (request: PlcSetStateRequest) => {
      requests.push(request)
      if (request === 'cold-restart') {
        if (firmware === 'old') {
          state = PlcRuntimeState.STOPPED // an older firmware reads 0x03 as STOP
          return Promise.resolve({ success: true, state })
        }
        if (state === PlcRuntimeState.RUNNING) {
          return Promise.resolve(
            parsePlcSetStateResponse(
              Uint8Array.from([ModbusFunctionCode.PLC_SET_STATE, ModbusDebugResponse.REFUSED_RUNNING, state, 1]),
            ),
          )
        }
        state = PlcRuntimeState.RUNNING
        return Promise.resolve({ success: true, state })
      }
      state = request
      return Promise.resolve({ success: true, state })
    },
    getStatus: () => Promise.resolve({ success: true, running: state === PlcRuntimeState.RUNNING, plcState: state }),
  } as unknown as DeviceDebugChannel
  return { channel, requests, state: () => state }
}

describe('cold restart', () => {
  it('is FC 0x4b with request byte 0x03 (0x02 is ERROR in the replies)', () => {
    const pdu = buildPlcSetStateRequest('cold-restart')
    expect(Array.from(pdu)).toEqual([ModbusFunctionCode.PLC_SET_STATE, PLC_REQUEST_COLD_RESTART])
    expect(PLC_REQUEST_COLD_RESTART).toBe(0x03)
    expect(Array.from(buildPlcSetStateRequest(PlcRuntimeState.RUNNING))).toEqual([ModbusFunctionCode.PLC_SET_STATE, 1])
    expect(Array.from(buildPlcSetStateRequest(PlcRuntimeState.STOPPED))).toEqual([ModbusFunctionCode.PLC_SET_STATE, 0])
  })

  it('decodes the refusal while running (0x88) into a reason', () => {
    const result = parsePlcSetStateResponse(
      Uint8Array.from([ModbusFunctionCode.PLC_SET_STATE, ModbusDebugResponse.REFUSED_RUNNING, 1, 1]),
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/PLC is running.*stop the PLC first/)
  })

  it('stops a running board first, then cold-restarts it', async () => {
    const board = fakeBoard('current')
    const result = await channelPlcControl(board.channel).coldRestart()
    expect(result).toEqual({ success: true })
    expect(board.requests).toEqual([PlcRuntimeState.STOPPED, 'cold-restart'])
    expect(board.state()).toBe(PlcRuntimeState.RUNNING)
  })

  it('works on a board that is already stopped', async () => {
    const board = fakeBoard('current', PlcRuntimeState.STOPPED)
    expect(await channelPlcControl(board.channel).coldRestart()).toEqual({ success: true })
  })

  it('reports an older firmware that stayed stopped', async () => {
    const board = fakeBoard('old')
    const result = await channelPlcControl(board.channel).coldRestart()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/stayed stopped: its firmware predates the cold restart/)
    expect(result.error).toMatch(/retained values were not reset/)
  })

  it('reports a refusal by the mode switch', async () => {
    const channel = {
      setPlcState: (request: PlcSetStateRequest) =>
        Promise.resolve(request === 'cold-restart' ? { success: false, refusedBySwitch: true } : { success: true }),
    } as unknown as DeviceDebugChannel
    const result = await channelPlcControl(channel).coldRestart()
    expect(result).toEqual({
      success: false,
      error: 'The PLC cannot be cold-restarted: its physical mode switch is in STOP.',
    })
  })
})
