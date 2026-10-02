/**
 * `device.rtos` sets the board's RTOS mode switch, in the board's own settings,
 * where the build and the Board Settings screen both read it.
 */

import { openPLCStoreBase } from '@root/frontend/store'
import { readRtosSettings } from '@root/middleware/shared/utils/rtos'

// The FBD body applier reaches the FBD component modules, which do not load
// under jest. Nothing here applies an FBD body.
jest.mock('../apply/fbd', () => ({ applyFbdBody: () => [] }))

import { applySpec } from '../apply/plan'
import type { ApplySpec } from '../apply/schema'

const apply = (device: ApplySpec['device']) =>
  applySpec({ specVersion: 1, device }, { prune: false, projectPath: '/does/not/matter' })

const rtosSettings = () =>
  readRtosSettings(openPLCStoreBase.getState().deviceDefinitions.configuration.vendorScreenData)

describe('device.rtos', () => {
  it('turns RTOS mode off and on, and says so', async () => {
    const off = await apply({ rtos: { enabled: false } })
    expect(rtosSettings()).toEqual({ enabled: false, chosen: true })
    expect(off.changes).toContainEqual({ kind: 'device', action: 'update', name: 'rtos = off' })

    await apply({ rtos: { enabled: true } })
    expect(rtosSettings()).toEqual({ enabled: true, chosen: true })
  })

  it('is refused on a board whose core has no RTOS, and stores nothing', async () => {
    openPLCStoreBase.setState((state) => ({
      deviceAvailableOptions: {
        ...state.deviceAvailableOptions,
        availableBoards: new Map([
          ['Arduino Mega', { compiler: 'arduino-cli', core: 'arduino:avr', preview: '', specs: {} }],
        ]),
      },
    }))
    const outcome = await apply({ board: 'Arduino Mega', rtos: { enabled: true } })
    expect(outcome.errors).toContainEqual(expect.stringMatching(/Arduino Mega has no RTOS mode/))
    expect(rtosSettings().chosen).toBe(false)
    openPLCStoreBase.setState((state) => ({
      deviceAvailableOptions: { ...state.deviceAvailableOptions, availableBoards: new Map() },
    }))
  })

  it('lands on the board the same spec selects', async () => {
    await apply({ board: 'ESP32-S3', rtos: { enabled: false } })
    const { deviceBoard, vendorScreenData } = openPLCStoreBase.getState().deviceDefinitions.configuration
    expect(deviceBoard).toBe('ESP32-S3')
    expect(readRtosSettings(vendorScreenData).enabled).toBe(false)
  })
})
