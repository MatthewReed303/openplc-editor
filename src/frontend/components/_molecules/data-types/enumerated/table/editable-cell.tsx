import { CellContext } from '@tanstack/react-table'
import { useEffect, useRef, useState } from 'react'

import { cn } from '../../../../../utils/cn'
import { InputWithRef } from '../../../../_atoms/input'

type EnumeratedRow = { description: string; value?: string }

type EditableCellProps = CellContext<EnumeratedRow, unknown> & {
  editable?: boolean
  onBlur: () => void
  id: string
  selectedRow: number
}

const DescriptionCell = ({ getValue, editable = true, onBlur, id, selectedRow }: EditableCellProps) => {
  const initialValue = getValue<string>()
  const [cellValue, setCellValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (selectedRow !== -1) inputRef.current?.focus()
  }, [selectedRow])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setCellValue(newValue)
  }

  return (
    <InputWithRef
      value={cellValue || ''}
      onChange={handleChange}
      className={cn(
        `flex w-full flex-1 bg-transparent p-2 text-center outline-none ${!editable ? 'pointer-events-none' : ''}`,
      )}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onBlur()
        }
      }}
      id={id}
      ref={inputRef}
    />
  )
}

type ValueCellProps = CellContext<EnumeratedRow, unknown> & {
  editable?: boolean
  /** Stores the value; false when it was refused, and the cell shows the stored value again. */
  onCommit: (value: string) => boolean
  id: string
  /** The value the member has without one of its own, shown greyed. */
  implicitValue?: string
}

/**
 * A member's value (IEC 61131-3 Ed.3 6.4.4.3, data type with named values):
 * an integer literal, or empty for one more than the member before it.
 */
const ValueCell = ({ getValue, editable = true, onCommit, id, implicitValue }: ValueCellProps) => {
  const stored = getValue<string | undefined>() ?? ''
  const [cellValue, setCellValue] = useState(stored)

  useEffect(() => {
    setCellValue(stored)
  }, [stored])

  const commit = () => {
    if (cellValue.trim() === stored) return
    if (!onCommit(cellValue.trim())) setCellValue(stored)
  }

  return (
    <InputWithRef
      value={cellValue}
      placeholder={implicitValue}
      aria-label='Enumerated value'
      onChange={(e) => setCellValue(e.target.value)}
      className={cn(
        `flex w-full flex-1 bg-transparent p-2 text-center outline-none placeholder:text-neutral-400 ${!editable ? 'pointer-events-none' : ''}`,
      )}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      id={id}
    />
  )
}

export { DescriptionCell, ValueCell }
