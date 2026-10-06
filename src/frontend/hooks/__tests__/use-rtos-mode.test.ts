import { beforeEach, describe, expect, it } from '@jest/globals'
import { renderHook } from '@testing-library/react'

import type { BoardInfo } from '../../../middleware/shared/ports/types'
import type { OpenPLCStore } from '../../store'
import { createStoreWrapper, createTestStore } from '../../store/testing'
import { useRtosMode } from '../use-rtos-mode'

let store: OpenPLCStore

beforeEach(() => {
  store = createTestStore()
})

const boards = new Map<string, BoardInfo>([
  ['ESP32-S3', { compiler: 'arduino-cli', core: 'esp32:esp32', preview: '', specs: {} }],
  ['Arduino Mega', { compiler: 'arduino-cli', core: 'arduino:avr', preview: '', specs: {} }],
])

function select(deviceBoard: string, vendorScreenData: Record<string, unknown>) {
  store.setState((state) => ({
    deviceAvailableOptions: { ...state.deviceAvailableOptions, availableBoards: boards },
    deviceDefinitions: {
      ...state.deviceDefinitions,
      configuration: { ...state.deviceDefinitions.configuration, deviceBoard, vendorScreenData },
    },
  }))
}

describe('useRtosMode', () => {
  beforeEach(() => select('ESP32-S3', {}))

  it('is on by default for a board whose core has an RTOS', () => {
    const { result } = renderHook(() => useRtosMode(), { wrapper: createStoreWrapper(store) })
    expect(result.current).toEqual({
      profile: { backend: 'freertos-esp32', tickNs: 1_000_000, workLevels: 8, maxTasks: 8, threads: 'native' },
      chosen: false,
    })
  })

  it('says when the user chose it', () => {
    select('ESP32-S3', { rtos: { enabled: true } })
    expect(renderHook(() => useRtosMode(), { wrapper: createStoreWrapper(store) }).result.current?.chosen).toBe(true)
  })

  it('is off when the switch is off, or the board has no RTOS', () => {
    select('ESP32-S3', { rtos: { enabled: false } })
    expect(renderHook(() => useRtosMode(), { wrapper: createStoreWrapper(store) }).result.current).toBeUndefined()
    select('Arduino Mega', {})
    expect(renderHook(() => useRtosMode(), { wrapper: createStoreWrapper(store) }).result.current).toBeUndefined()
  })
})
