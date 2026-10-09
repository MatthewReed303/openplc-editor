import { act, fireEvent, render, screen } from '@testing-library/react'

const toastMock = vi.fn()
vi.mock('@root/frontend/components/_features/[app]/toast/use-toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
  useToast: () => ({ toast: toastMock }),
}))

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { PLCDataType } from '@root/middleware/shared/ports/types'

import { EnumeratorDataType } from '..'

type Enumerated = Extract<PLCDataType, { derivation: 'enumerated' }>

// A data type with named values (IEC 61131-3 Ed.3 6.4.4.3).
const status: Enumerated = {
  name: 'Status',
  derivation: 'enumerated',
  baseType: 'USINT',
  initialValue: 'IDLE',
  values: [{ description: 'IDLE', value: '0' }, { description: 'RUN' }, { description: 'FAULT', value: '9' }],
}

let store: OpenPLCStore

const stored = () => store.getState().project.data.dataTypes.find((dt) => dt.name === 'Status') as Enumerated

const renderTable = () =>
  render(<EnumeratorDataType data={stored()} />, {
    wrapper: createStoreWrapper(store),
  })

const commit = async (input: HTMLElement, value: string) => {
  await act(async () => {
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
  })
}

describe('the enumerated data type editor, with named values', () => {
  beforeEach(() => {
    toastMock.mockClear()
    store = createTestStore()
    store.getState().datatypeActions.create({ name: 'Status', derivation: 'enumerated' })
    store.getState().projectActions.updateDatatype('Status', status)
  })

  it('shows the base type and each value, a counted-on one greyed', () => {
    renderTable()
    expect(screen.getByLabelText('Enumerated base type').textContent).toContain('USINT')
    const inputs = screen.getAllByLabelText<HTMLInputElement>('Enumerated value')
    expect(inputs.map((input) => input.value)).toEqual(['0', '', '9'])
    expect(inputs[1].placeholder).toBe('1')
  })

  it('stores a value that fits, and refuses one that does not', async () => {
    renderTable()
    const fault = () => screen.getAllByLabelText<HTMLInputElement>('Enumerated value')[2]

    await commit(fault(), '300')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: '"FAULT" = 300 is out of range for USINT (0..255)' }),
    )
    expect(stored().values[2]).toEqual({ description: 'FAULT', value: '9' })
    expect(fault().value).toBe('9')

    await commit(fault(), '1')
    expect(toastMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: '"FAULT" and "RUN" both have the value 1' }),
    )

    await commit(fault(), '16#20')
    expect(stored().values[2]).toEqual({ description: 'FAULT', value: '16#20' })
  })

  it('clears a value, leaving the member one more than the one before', async () => {
    renderTable()
    await commit(screen.getAllByLabelText('Enumerated value')[2], '')
    expect(stored().values[2]).toEqual({ description: 'FAULT' })
  })

  it('shows a plain enumeration as one with no base type', () => {
    store.getState().projectActions.updateDatatype('Status', {
      name: 'Status',
      derivation: 'enumerated',
      initialValue: '',
      values: [{ description: 'A' }],
    })
    renderTable()
    expect(screen.getByLabelText('Enumerated base type').textContent).toContain('None (enumeration)')
    expect(screen.getAllByLabelText<HTMLInputElement>('Enumerated value')[0].placeholder).toBe('0')
  })
})
