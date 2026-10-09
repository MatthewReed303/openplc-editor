/**
 * Enumerations and data types with named values (IEC 61131-3 Ed.3, Table 11
 * features 1 and 2).
 *
 * An enumeration (6.4.4.2) is a list of names: `Mode : (IDLE, RUN);`. A data
 * type with named values (6.4.4.3) gives the type a base and each name a value
 * of that base: `Status : USINT (IDLE := 0, RUN := 1);`. Both are the editor's
 * `enumerated` derivation; `baseType` and a value's `value` are what make the
 * second form, and a data type without them is exactly the first.
 *
 * The editor, the CLI and the serialisers share these rules so a value the
 * table accepts is one `apply` accepts and STruC++ compiles.
 */

import type { PLCDataType } from '../../../middleware/shared/ports/types'

export type PLCEnumeratedDataType = Extract<PLCDataType, { derivation: 'enumerated' }>

/**
 * The base types a data type with named values may have. The grammar admits any
 * elementary type, but its values are integers (`Int_Literal | Constant_Expr`),
 * so these are the IEC integer and bit-string types STruC++ maps to a C++ enum.
 */
export const ENUM_BASE_TYPES = [
  'SINT',
  'INT',
  'DINT',
  'LINT',
  'USINT',
  'UINT',
  'UDINT',
  'ULINT',
  'BYTE',
  'WORD',
  'DWORD',
  'LWORD',
] as const

export type EnumBaseType = (typeof ENUM_BASE_TYPES)[number]

/**
 * The value range of each base type. An enumeration without a base keeps its
 * values in INT, which is how STruC++ stores it.
 */
const RANGES: Record<EnumBaseType, readonly [bigint, bigint]> = {
  SINT: [-128n, 127n],
  INT: [-32768n, 32767n],
  DINT: [-2147483648n, 2147483647n],
  LINT: [-9223372036854775808n, 9223372036854775807n],
  USINT: [0n, 255n],
  UINT: [0n, 65535n],
  UDINT: [0n, 4294967295n],
  ULINT: [0n, 18446744073709551615n],
  BYTE: [0n, 255n],
  WORD: [0n, 65535n],
  DWORD: [0n, 4294967295n],
  LWORD: [0n, 18446744073709551615n],
}

/** The canonical (upper-case) base type, or undefined when it is not one of `ENUM_BASE_TYPES`. */
export function normalizeEnumBaseType(baseType: string | undefined): EnumBaseType | undefined {
  const upper = baseType?.trim().toUpperCase()
  return (ENUM_BASE_TYPES as readonly string[]).includes(upper ?? '') ? (upper as EnumBaseType) : undefined
}

/** The range a member's value must fall in: the base type's, or INT's without one. */
export function enumValueRange(baseType: string | undefined): readonly [bigint, bigint] {
  return RANGES[normalizeEnumBaseType(baseType) ?? 'INT']
}

/**
 * An IEC integer literal (6.3.3): an optional sign, then decimal digits or a
 * `2#`, `8#` or `16#` based number, with single underscores between digits.
 * Undefined for anything else, including an expression.
 */
export function parseIecInteger(text: string): bigint | undefined {
  const match = /^([+-]?)(?:(2|8|16)#)?([0-9A-Fa-f]+(?:_[0-9A-Fa-f]+)*)$/.exec(text.trim())
  if (!match) return undefined
  const [, sign, base, body] = match
  const digits = body.replace(/_/g, '')
  const allowed = base === '2' ? /^[01]+$/ : base === '8' ? /^[0-7]+$/ : base === '16' ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/
  if (!allowed.test(digits)) return undefined
  // A sign on a based literal is not IEC syntax: `-16#FF` is an expression.
  if (base && sign) return undefined
  const prefix = base === '2' ? '0b' : base === '8' ? '0o' : base === '16' ? '0x' : ''
  const magnitude = BigInt(prefix + digits)
  return sign === '-' ? -magnitude : magnitude
}

/** Has the data type the named-values form: a base type or any explicit value. */
export function hasNamedValues(dataType: PLCEnumeratedDataType): boolean {
  return (dataType.baseType ?? '') !== '' || dataType.values.some((v) => (v.value ?? '') !== '')
}

/**
 * The value of each member, as STruC++ gives it: an explicit value, else one
 * more than the member before it (the first is 0). Undefined where it depends
 * on a value that is not an integer literal.
 */
export function enumMemberValues(dataType: PLCEnumeratedDataType): Array<{ name: string; value?: bigint }> {
  let next: bigint | undefined = 0n
  return dataType.values.map((member) => {
    const explicit = (member.value ?? '').trim()
    const value = explicit === '' ? next : parseIecInteger(explicit)
    next = value === undefined ? undefined : value + 1n
    return value === undefined ? { name: member.description } : { name: member.description, value }
  })
}

/**
 * Member names by numeric value, for showing a value the PLC reports. An
 * enumeration's members are numbered from 0 in order; a named-values member
 * has the value it was given.
 */
export function enumValueNames(dataType: PLCEnumeratedDataType): Map<string, string> {
  const names = new Map<string, string>()
  for (const member of enumMemberValues(dataType)) {
    if (member.value !== undefined && !names.has(member.value.toString())) {
      names.set(member.value.toString(), member.name)
    }
  }
  return names
}

/**
 * What is wrong with an enumerated data type's base type, values and initial
 * value, one sentence each; empty when nothing is. Names are checked elsewhere
 * (they are identifiers, with the identifier rules).
 */
export function validateEnumeratedDataType(dataType: PLCEnumeratedDataType): string[] {
  const baseType = (dataType.baseType ?? '').trim()
  if (baseType !== '' && normalizeEnumBaseType(baseType) === undefined) {
    return [`base type "${baseType}" is not an integer or bit-string type (${ENUM_BASE_TYPES.join(', ')})`]
  }
  const problems: string[] = []
  const seenNames = new Set<string>()
  for (const member of dataType.values) {
    const key = member.description.toUpperCase()
    if (seenNames.has(key)) problems.push(`value name "${member.description}" is declared twice`)
    else seenNames.add(key)
  }
  problems.push(...validateEnumValues(dataType))

  const shownBase = normalizeEnumBaseType(baseType) ?? 'INT'
  const [low, high] = enumValueRange(baseType)
  // `Status#IDLE` names the member IDLE.
  const qualified = new RegExp(`^${dataType.name}#`, 'i')
  const initial = (dataType.initialValue ?? '').trim().replace(qualified, '')
  if (initial !== '' && !seenNames.has(initial.toUpperCase())) {
    // 6.4.4.3.2: a named-values type may start at any value of its base type.
    const number = baseType !== '' ? parseIecInteger(initial) : undefined
    if (number === undefined) {
      problems.push(
        baseType !== ''
          ? `initial value "${initial}" is neither one of its values nor an integer`
          : `initial value "${initial}" is not one of its values`,
      )
    } else if (number < low || number > high) {
      problems.push(`initial value ${number} is out of range for ${shownBase} (${low}..${high})`)
    }
  }
  return problems
}

/**
 * What is wrong with the members' values alone: each an integer literal, in the
 * base type's range (INT's without one), and no two members with one value.
 */
export function validateEnumValues(dataType: PLCEnumeratedDataType): string[] {
  const problems: string[] = []
  const baseType = (dataType.baseType ?? '').trim()
  const shownBase = normalizeEnumBaseType(baseType) ?? 'INT'
  const [low, high] = enumValueRange(baseType)
  const valued = enumMemberValues(dataType)
  dataType.values.forEach((member, index) => {
    const explicit = (member.value ?? '').trim()
    if (explicit !== '' && parseIecInteger(explicit) === undefined) {
      problems.push(`"${member.description}" := ${explicit} is not an integer literal`)
      return
    }
    const value = valued[index].value
    if (value !== undefined && (value < low || value > high)) {
      const how = explicit === '' ? ' (one more than the value before it)' : ''
      problems.push(`"${member.description}" = ${value}${how} is out of range for ${shownBase} (${low}..${high})`)
    }
  })

  const byValue = new Map<string, string>()
  for (const member of valued) {
    if (member.value === undefined) continue
    const key = member.value.toString()
    const other = byValue.get(key)
    if (other !== undefined) problems.push(`"${member.name}" and "${other}" both have the value ${key}`)
    else byValue.set(key, member.name)
  }

  return problems
}
