/**
 * Enumerations and data types with named values (IEC 61131-3 Ed.3 Table 11
 * features 1 and 2): the rules the data-type table, `apply` and the debugger
 * share.
 */
import { create } from 'xmlbuilder2'

import type { PLCDataType } from '../../../../middleware/shared/ports/types'
import {
  ENUM_BASE_TYPES,
  enumMemberValues,
  enumValueNames,
  hasNamedValues,
  normalizeEnumBaseType,
  parseIecInteger,
  type PLCEnumeratedDataType,
  validateEnumeratedDataType,
} from '../enum-named-values'
import { parseDataTypeFromText } from '../data-type-declarations'
import { serializeDataTypesToST, serializeDataTypeToText } from '../data-type-serializer'
import { getBaseCodeSysXmlStructure } from '../xml-generator/codesys/base-xml'
import { codeSysParseDataTypesToXML } from '../xml-generator/codesys/data-type-xml'
import { getBaseOldEditorXmlStructure } from '../xml-generator/old-editor/base-xml'
import { oldEditorParseDataTypesToXML } from '../xml-generator/old-editor/data-type-xml'
import { parseDataTypesXml } from '../xml-parser/data-type-xml'
import { parseXmlDocument } from '../xml-parser/parse-xml-document'

const statusType: PLCEnumeratedDataType = {
  name: 'UT_STATUS',
  derivation: 'enumerated',
  baseType: 'USINT',
  values: [{ description: 'IDLE', value: '0' }, { description: 'RUN' }, { description: 'FAULT', value: '16#20' }],
  initialValue: 'IDLE',
}

const plainType: PLCEnumeratedDataType = {
  name: 'Mode',
  derivation: 'enumerated',
  values: [{ description: 'Auto' }, { description: 'Manual' }],
  initialValue: 'Auto',
}

const status = statusType
const plain = plainType

describe('parseIecInteger', () => {
  it('reads decimal, signed and based literals with underscores', () => {
    expect(parseIecInteger('42')).toBe(42n)
    expect(parseIecInteger('-7')).toBe(-7n)
    expect(parseIecInteger('+7')).toBe(7n)
    expect(parseIecInteger('1_000')).toBe(1000n)
    expect(parseIecInteger('16#FF')).toBe(255n)
    expect(parseIecInteger('16#00FF_0000')).toBe(0xff0000n)
    expect(parseIecInteger('8#17')).toBe(15n)
    expect(parseIecInteger('2#1010')).toBe(10n)
    expect(parseIecInteger('18446744073709551615')).toBe(18446744073709551615n)
  })

  it('refuses what is not an integer literal', () => {
    for (const text of ['', 'A', '1.5', '16#G1', '2#102', '-16#FF', '1__0', '_1', 'A + 1']) {
      expect(parseIecInteger(text)).toBeUndefined()
    }
  })
})

describe('enumMemberValues', () => {
  it('numbers an enumeration from 0, as STruC++ does', () => {
    expect(enumMemberValues(plain)).toEqual([
      { name: 'Auto', value: 0n },
      { name: 'Manual', value: 1n },
    ])
  })

  it('continues from an explicit value with one more each', () => {
    expect(enumMemberValues(status)).toEqual([
      { name: 'IDLE', value: 0n },
      { name: 'RUN', value: 1n },
      { name: 'FAULT', value: 32n },
    ])
    expect(enumValueNames(status)).toEqual(
      new Map([
        ['0', 'IDLE'],
        ['1', 'RUN'],
        ['32', 'FAULT'],
      ]),
    )
  })

  it('knows the named-values form by a base type or any explicit value', () => {
    expect(hasNamedValues(plain)).toBe(false)
    expect(hasNamedValues(status)).toBe(true)
    expect(hasNamedValues({ ...plain, values: [{ description: 'A', value: '3' }] })).toBe(true)
  })
})

describe('validateEnumeratedDataType', () => {
  it('accepts an enumeration and a data type with named values', () => {
    expect(validateEnumeratedDataType(plain)).toEqual([])
    expect(validateEnumeratedDataType(status)).toEqual([])
    expect(validateEnumeratedDataType({ ...status, initialValue: '27' })).toEqual([])
  })

  it('offers the IEC integer and bit-string base types, in any case', () => {
    expect(ENUM_BASE_TYPES).toEqual([
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
    ])
    expect(normalizeEnumBaseType('usint')).toBe('USINT')
    expect(validateEnumeratedDataType({ ...status, baseType: 'REAL' })).toEqual([
      'base type "REAL" is not an integer or bit-string type (SINT, INT, DINT, LINT, USINT, UINT, UDINT, ULINT, BYTE, WORD, DWORD, LWORD)',
    ])
  })

  it('refuses two members with one value, an explicit one or one counted on', () => {
    const status = { ...statusType, initialValue: '' }
    expect(
      validateEnumeratedDataType({
        ...status,
        values: [
          { description: 'A', value: '1' },
          { description: 'B', value: '1' },
        ],
      }),
    ).toEqual(['"B" and "A" both have the value 1'])
    expect(
      validateEnumeratedDataType({
        ...status,
        values: [{ description: 'A', value: '1' }, { description: 'B' }, { description: 'C', value: '2' }],
      }),
    ).toEqual(['"C" and "B" both have the value 2'])
  })

  it('refuses a value out of the base range, or INT range without a base', () => {
    const status = { ...statusType, initialValue: '' }
    const plain = { ...plainType, initialValue: '' }
    expect(validateEnumeratedDataType({ ...status, values: [{ description: 'A', value: '256' }] })).toEqual([
      '"A" = 256 is out of range for USINT (0..255)',
    ])
    expect(
      validateEnumeratedDataType({ ...status, values: [{ description: 'A', value: '255' }, { description: 'B' }] }),
    ).toEqual(['"B" = 256 (one more than the value before it) is out of range for USINT (0..255)'])
    expect(
      validateEnumeratedDataType({ ...status, baseType: 'SINT', values: [{ description: 'A', value: '-129' }] }),
    ).toEqual(['"A" = -129 is out of range for SINT (-128..127)'])
    expect(validateEnumeratedDataType({ ...plain, values: [{ description: 'A', value: '40000' }] })).toEqual([
      '"A" = 40000 is out of range for INT (-32768..32767)',
    ])
  })

  it('refuses a value that is not an integer literal, and a name declared twice', () => {
    const status = { ...statusType, initialValue: '' }
    const plain = { ...plainType, initialValue: '' }
    expect(validateEnumeratedDataType({ ...status, values: [{ description: 'A', value: 'B + 1' }] })).toEqual([
      '"A" := B + 1 is not an integer literal',
    ])
    expect(validateEnumeratedDataType({ ...plain, values: [{ description: 'A' }, { description: 'a' }] })).toEqual([
      'value name "a" is declared twice',
    ])
  })

  it('takes a number as the initial value only with a base type (6.4.4.3.2)', () => {
    expect(validateEnumeratedDataType({ ...plain, initialValue: '1' })).toEqual([
      'initial value "1" is not one of its values',
    ])
    expect(validateEnumeratedDataType({ ...status, initialValue: '300' })).toEqual([
      'initial value 300 is out of range for USINT (0..255)',
    ])
    expect(validateEnumeratedDataType({ ...status, initialValue: 'idle' })).toEqual([])
  })
})

describe('a data type with named values in a .dt file', () => {
  it('is written in the IEC form', () => {
    expect(serializeDataTypeToText(status)).toBe(
      'TYPE\n  UT_STATUS : USINT (IDLE := 0, RUN, FAULT := 16#20) := IDLE;\nEND_TYPE\n',
    )
    expect(serializeDataTypesToST([plain])).toBe('TYPE\n  Mode : (Auto, Manual) := Auto;\nEND_TYPE\n')
  })

  it('round-trips, with a numeric initial value too', () => {
    expect(parseDataTypeFromText(serializeDataTypeToText(status), 'UT_STATUS')).toEqual({ dataType: status })
    const numeric = { ...status, initialValue: '27' }
    expect(parseDataTypeFromText(serializeDataTypeToText(numeric), 'UT_STATUS')).toEqual({ dataType: numeric })
    const valuesOnly: PLCEnumeratedDataType = {
      ...plain,
      values: [{ description: 'A', value: '5' }, { description: 'B' }],
      initialValue: 'B',
    }
    expect(parseDataTypeFromText(serializeDataTypeToText(valuesOnly), 'Mode')).toEqual({ dataType: valuesOnly })
  })

  it('keeps the base type of one with no values yet', () => {
    expect(parseDataTypeFromText('TYPE\n  S : USINT ();\nEND_TYPE\n', 'S')).toEqual({
      dataType: { name: 'S', derivation: 'enumerated', baseType: 'USINT', values: [], initialValue: '' },
    })
  })

  it('reads a hand-written one as the user spelled it', () => {
    const text = 'TYPE\n  Colors : DWORD (Red := 16#00FF0000, Green := 16#0000FF00) := Green;\nEND_TYPE\n'
    expect(parseDataTypeFromText(text, 'Colors')).toEqual({
      dataType: {
        name: 'Colors',
        derivation: 'enumerated',
        baseType: 'DWORD',
        values: [
          { description: 'Red', value: '16#00FF0000' },
          { description: 'Green', value: '16#0000FF00' },
        ],
        initialValue: 'Green',
      },
    })
  })
})

describe('a data type with named values in PLCopen XML', () => {
  const roundTrip = (xml: ReturnType<typeof getBaseOldEditorXmlStructure>, dataTypes: PLCDataType[]) => {
    const text = create(xml as never).end()
    const project = parseXmlDocument(text)
    const types = ((project.types as Record<string, unknown>).dataTypes as Record<string, unknown>).dataType
    return parseDataTypesXml(types)
  }

  it('exports the TC6 enum values and baseType, and imports them back', () => {
    const xml = oldEditorParseDataTypesToXML(getBaseOldEditorXmlStructure(), [status])
    const exported = xml.project.types.dataTypes.dataType[0] as { baseType: { enum: unknown } }
    expect(exported.baseType.enum).toEqual({
      values: {
        value: [{ '@name': 'IDLE', '@value': '0' }, { '@name': 'RUN' }, { '@name': 'FAULT', '@value': '16#20' }],
      },
      baseType: { USINT: '' },
    })
    expect(roundTrip(xml, [status])).toEqual([status])
  })

  it('exports the same from the CODESYS flavour', () => {
    const xml = codeSysParseDataTypesToXML(getBaseCodeSysXmlStructure(), [status])
    const exported = xml.project.types.dataTypes.dataType[0] as { baseType: { enum: unknown } }
    expect(exported.baseType.enum).toEqual({
      values: {
        value: [{ '@name': 'IDLE', '@value': '0' }, { '@name': 'RUN' }, { '@name': 'FAULT', '@value': '16#20' }],
      },
      baseType: { USINT: '' },
    })
  })

  it('leaves an enumeration as it was', () => {
    const xml = oldEditorParseDataTypesToXML(getBaseOldEditorXmlStructure(), [plain])
    const exported = xml.project.types.dataTypes.dataType[0] as { baseType: { enum: unknown } }
    expect(exported.baseType.enum).toEqual({ values: { value: [{ '@name': 'Auto' }, { '@name': 'Manual' }] } })
    expect(roundTrip(xml, [plain])).toEqual([plain])
  })
})
