import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import React, { useEffect, useRef } from 'react'

import type { PLCDataType } from '../../../../../../middleware/shared/ports/types'
import { usePouSnapshot } from '../../../../../hooks/use-pou-snapshot'
import { useOpenPLCStore } from '../../../../../store'
import { enumeratedValidation } from '../../../../../store/slices/project/validation/variables'
import { cn } from '../../../../../utils/cn'
import { enumMemberValues, validateEnumValues } from '../../../../../utils/PLC/enum-named-values'
import { GenericDataTypeTable } from '../../../../_atoms/generic-data-type-table'
import { toast } from '../../../../_features/[app]/toast/use-toast'
import { DescriptionCell, ValueCell } from './editable-cell'

type PLCEnumeratedDatatype = Extract<PLCDataType, { derivation: 'enumerated' }>

type DataTypeEnumeratedTableProps = {
  name: string
  values: PLCEnumeratedDatatype['values']
  initialValue?: string
  selectedRow: number
  handleRowClick: (row: HTMLTableRowElement) => void
  setArrayTable: React.Dispatch<React.SetStateAction<{ selectedRow: number }>>
}

const EnumeratedTable = ({
  name,
  values,
  initialValue,
  selectedRow,
  handleRowClick,
  setArrayTable,
}: DataTypeEnumeratedTableProps) => {
  const tableBodyRef = useRef<HTMLTableSectionElement>(null)
  const tableBodyRowRef = useRef<HTMLTableRowElement>(null)

  const {
    editor,
    project: {
      data: { dataTypes },
    },
    projectActions: { updateDatatype },
    sharedWorkspaceActions: { handleFileAndWorkspaceSavedState },
  } = useOpenPLCStore()

  const { captureAndPush } = usePouSnapshot()

  // `updateDatatype` is a full replace.  Read the current entry from
  // the store and spread it before writing so we don't strip
  // `name` / `derivation` / `initialValue` from the enumerated
  // datatype (which would corrupt it for downstream consumers).
  const writeValues = (newValues: PLCEnumeratedDatatype['values']) => {
    const current = dataTypes.find((dt) => dt.name === name)
    if (!current || current.derivation !== 'enumerated') return
    updateDatatype(name, { ...current, values: newValues })
    handleFileAndWorkspaceSavedState(editor.meta.name)
  }

  // The value each member has without one of its own, for the greyed hint.
  const implicitValues = React.useMemo(() => {
    const current = dataTypes.find((dt) => dt.name === name)
    if (!current || current.derivation !== 'enumerated') return []
    return enumMemberValues({ ...current, values }).map((member) => member.value?.toString())
  }, [values, name, dataTypes])

  const columnHelper = createColumnHelper<{ description: string; value?: string }>()
  const columns = React.useMemo(
    () => [
      columnHelper.accessor('description', {
        size: 900,
        minSize: 350,
        maxSize: 900,
        enableResizing: true,
        cell: (cellProps) => (
          <DescriptionCell
            key={cellProps.row.id}
            onBlur={() => handleBlur(cellProps.row.index)}
            id={`description-input-${cellProps.row.index}`}
            selectedRow={selectedRow === cellProps.row.index ? selectedRow : -1}
            {...cellProps}
          />
        ),
      }),
      columnHelper.accessor('value', {
        size: 160,
        minSize: 100,
        maxSize: 200,
        enableResizing: false,
        cell: (cellProps) => (
          <ValueCell
            key={`value-${cellProps.row.id}`}
            id={`value-input-${cellProps.row.index}`}
            implicitValue={implicitValues[cellProps.row.index]}
            onCommit={(value) => commitValue(cellProps.row.index, value)}
            {...cellProps}
          />
        ),
      }),
    ],
    [values, name, selectedRow, initialValue, implicitValues],
  )

  /**
   * Store a member's value, if the data type stays valid: an integer literal,
   * in the base type's range, and no two members with one value. An empty
   * value clears it.
   */
  const commitValue = (rowIndex: number, value: string): boolean => {
    const current = dataTypes.find((dt) => dt.name === name)
    if (!current || current.derivation !== 'enumerated') return false
    const newRows = values.map((row, index) => {
      if (index !== rowIndex) return row
      const { value: _previous, ...rest } = row
      return value === '' ? rest : { ...rest, value }
    })
    const problems = validateEnumValues({ ...current, values: newRows })
    if (problems.length > 0) {
      toast({ title: 'Invalid enumerated value', description: problems[0], variant: 'fail' })
      return false
    }
    captureAndPush(editor.meta.name)
    writeValues(newRows)
    return true
  }

  const handleBlur = (rowIndex: number) => {
    const prevRows = [...values]

    const inputElement = document.getElementById(`description-input-${rowIndex}`) as HTMLInputElement
    // Runs on every blur: an unchanged value must not even leave an undo entry behind.
    // An empty one still falls through, so an abandoned new row is removed as before.
    const untouched = inputElement?.value.trim()
    if (untouched && prevRows[rowIndex]?.description === untouched) return prevRows
    captureAndPush(editor.meta.name)
    if (inputElement) {
      const inputValue = inputElement.value.trim()

      if (inputValue === '') {
        const newRows = prevRows.filter((_, index) => index !== rowIndex)
        writeValues(newRows)
        resetBorders()
        setArrayTable({ selectedRow: -1 })
        toast({
          title: 'Row removed',
          description: `The row was removed because the value was empty.`,
          variant: 'fail',
        })
        return newRows
      }

      const validation = enumeratedValidation({ value: inputValue })
      const checkIfExists = prevRows.some((row, i) => i !== rowIndex && row.description === inputValue)

      if (checkIfExists) {
        const newRows = prevRows.filter((_, index) => index !== rowIndex)
        writeValues(newRows)
        resetBorders()
        setArrayTable({ selectedRow: -1 })
        toast({
          title: 'Value already exists',
          description: `The value already exists in the list.`,
          variant: 'fail',
        })
        return newRows
      }

      if (!validation.ok) {
        const newRows = prevRows.filter((_, index) => index !== rowIndex)
        writeValues(newRows)
        resetBorders()
        setArrayTable({ selectedRow: -1 })
        toast({
          title: 'Invalid enumerated value',
          description: `The enumerated value is invalid. Valid names: CamelCase, PascalCase or SnakeCase.`,
          variant: 'fail',
        })
        return newRows
      } else {
        const newRows = prevRows.map((row, index) => ({
          ...row,
          description: index === rowIndex ? inputValue : row.description,
        }))
        writeValues(newRows)
        return newRows
      }
    }
  }

  const resetBorders = () => {
    const parent = tableBodyRef.current
    if (!parent?.children) return

    const rows = Array.from(parent.children)
    rows.forEach((row) => {
      row.className = cn(
        row.className,
        '[&:last-child>td]:border-b-neutral-500 [&>td:first-child]:border-l-neutral-500 [&>td:last-child]:border-r-neutral-500 [&>td]:border-b-neutral-300',
        'dark:[&>td:first-child]:border-l-neutral-500 dark:[&>td:last-child]:border-r-neutral-500 dark:[&>td]:border-b-neutral-800',
        '[&:first-child>td]:border-t-neutral-500 dark:[&:first-child>td]:border-t-neutral-500',
        'shadow-none dark:shadow-none',
      )
    })
  }

  const setBorders = () => {
    const row = tableBodyRowRef.current
    const parent = tableBodyRef.current
    if (!row || !parent) return

    const element = row?.previousElementSibling ? row?.previousElementSibling : parent?.children[0]

    element.className = cn(element.className, '[&>td]:border-b-brand dark:[&>td]:border-b-brand')

    // First row
    if (row === element) {
      row.className = cn(row.className, '[&:first-child>td]:border-t-brand dark:[&:first-child>td]:border-t-brand')
    }

    row.className = cn(
      row.className,
      '[&:last-child>td]:border-b-brand [&>td:first-child]:border-l-brand [&>td:last-child]:border-r-brand [&>td]:border-b-brand',
      'dark:[&>td:first-child]:border-l-brand dark:[&>td:last-child]:border-r-brand dark:[&>td]:border-b-brand',
    )
  }

  useEffect(() => {
    resetBorders()
    setBorders()
  }, [selectedRow])

  const table = useReactTable({
    columns: columns,
    data: values,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
  })

  return (
    <GenericDataTypeTable
      context='data-type-enumerated'
      table={table}
      selectedRow={selectedRow}
      tableBodyRef={tableBodyRef}
      tableBodyRowRef={tableBodyRowRef}
      handleRowClick={handleRowClick}
    />
  )
}

export { EnumeratedTable }
