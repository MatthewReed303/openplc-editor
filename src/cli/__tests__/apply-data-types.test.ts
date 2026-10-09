/**
 * Data types, and the two ways a spec could produce one the editor cannot read.
 *
 * Both were found by driving a project through `apply` -> `check` and reading
 * the emitted TYPE block, which is the only place either showed up: the project
 * saved without complaint in each case.
 */

import { createTestStore } from '@root/frontend/store/testing'

// The FBD body applier reaches the FBD component modules, which do not load
// under jest. Nothing here applies an FBD body.
jest.mock('../apply/fbd', () => ({ applyFbdBody: () => [] }))

import { applySpec } from '../apply/plan'
import { type ApplySpec, parseApplySpec } from '../apply/schema'
import { describeDataType } from '../describe/data-types'

// One store for the file, as the process singleton was.
const store = createTestStore()

const dataTypesIn = () => store.getState().project.data.dataTypes

const apply = (dataTypes: unknown) =>
  applySpec(store, { specVersion: 1, dataTypes } as ApplySpec, { prune: false, projectPath: '/does/not/matter' })

describe('a structure member declared as an array', () => {
  // The store keeps an array's bounds in `type.data`; the spec states them as
  // `dimensions`. Passing the spec shape straight through left the member a
  // scalar of the element type — `Trend : INT` where `ARRAY [0..2] OF INT` was
  // asked for — and nothing reported it.
  it('keeps its bounds', async () => {
    const result = await apply([
      {
        derivation: 'structure',
        name: 'HasArray',
        variables: [{ name: 'Trend', type: { definition: 'array', value: 'INT', dimensions: ['0..2'] } }],
      },
    ])
    expect(result.errors).toEqual([])

    const stored = dataTypesIn().find((type) => type.name === 'HasArray')
    const member = (stored as unknown as { variable: Array<{ type: Record<string, unknown> }> }).variable[0]

    expect(member.type.value).toBe('ARRAY [0..2] OF INT')
    expect(member.type.data).toEqual({
      baseType: { definition: 'base-type', value: 'INT' },
      dimensions: [{ dimension: '0..2' }],
    })
  })
})

describe('a data type whose name is not a legal identifier', () => {
  // `createDatatype` accepts these. The `.dt` written for one then fails to
  // parse on the next load: the editor preserves the file and warns, but the
  // type is gone from the project and every reference to it fails to compile as
  // an undefined type.
  it('refuses a reserved structure field name', async () => {
    const result = await apply([
      {
        derivation: 'structure',
        name: 'BadField',
        variables: [{ name: 'Label', type: { definition: 'base-type', value: 'STRING' } }],
      },
    ])

    expect(result.errors.join(' ')).toContain('"Label" is a reserved word')
    expect(dataTypesIn().some((type) => type.name === 'BadField')).toBe(false)
  })

  it('refuses a reserved enumerated value', async () => {
    const result = await apply([{ derivation: 'enumerated', name: 'BadEnum', values: ['OK', 'WHILE'] }])

    expect(result.errors.join(' ')).toContain('"WHILE"')
    expect(dataTypesIn().some((type) => type.name === 'BadEnum')).toBe(false)
  })

  it('refuses a name with illegal characters', async () => {
    const result = await apply([
      {
        derivation: 'structure',
        name: 'Bad Name',
        variables: [{ name: 'Ok', type: { definition: 'base-type', value: 'INT' } }],
      },
    ])

    expect(result.errors.join(' ')).toContain('illegal characters')
  })

  it('accepts names that are legal', async () => {
    const result = await apply([
      {
        derivation: 'structure',
        name: 'GoodOne',
        variables: [{ name: 'Tag', type: { definition: 'base-type', value: 'STRING' } }],
      },
    ])

    expect(result.errors).toEqual([])
    expect(dataTypesIn().some((type) => type.name === 'GoodOne')).toBe(true)
  })
})

describe('a data type with named values (IEC 61131-3 Ed.3 6.4.4.3)', () => {
  // `T : USINT (A := 0, ...)`: a base type, and a value for each name. The spec
  // carries both, and `describe` gives back the spec `apply` took.
  const spec = {
    derivation: 'enumerated',
    name: 'UT_STATUS',
    baseType: 'usint',
    values: [{ name: 'UT_ST_IDLE', value: 0 }, 'UT_ST_RUN', { name: 'UT_ST_FAULT', value: '16#20' }],
    initialValue: 'UT_ST_IDLE',
  }

  it('is a valid spec, values given as names or as { name, value }', () => {
    expect(parseApplySpec({ specVersion: 1, dataTypes: [spec] }).ok).toBe(true)
    expect(parseApplySpec({ specVersion: 1, dataTypes: [{ ...spec, values: [{ name: 'A', valu: 1 }] }] }).ok).toBe(
      false,
    )
  })

  it('is stored with its base type and values, and described back as the spec', async () => {
    const result = await apply([spec])
    expect(result.errors).toEqual([])

    const stored = dataTypesIn().find((type) => type.name === 'UT_STATUS')
    expect(stored).toEqual({
      name: 'UT_STATUS',
      derivation: 'enumerated',
      baseType: 'USINT',
      initialValue: 'UT_ST_IDLE',
      values: [
        { description: 'UT_ST_IDLE', value: '0' },
        { description: 'UT_ST_RUN' },
        { description: 'UT_ST_FAULT', value: '16#20' },
      ],
    })
    const described = describeDataType(stored!)
    expect(described).toEqual({
      name: 'UT_STATUS',
      derivation: 'enumerated',
      baseType: 'USINT',
      values: [{ name: 'UT_ST_IDLE', value: '0' }, 'UT_ST_RUN', { name: 'UT_ST_FAULT', value: '16#20' }],
      initialValue: 'UT_ST_IDLE',
    })

    // Applying what describe produced changes nothing.
    expect((await apply([described])).errors).toEqual([])
    expect(dataTypesIn().find((type) => type.name === 'UT_STATUS')).toEqual(stored)
  })

  it('leaves a plain enumeration exactly as before', async () => {
    expect((await apply([{ derivation: 'enumerated', name: 'Plain', values: ['A', 'B'] }])).errors).toEqual([])
    const stored = dataTypesIn().find((type) => type.name === 'Plain')
    expect(stored).toEqual({
      name: 'Plain',
      derivation: 'enumerated',
      initialValue: '',
      values: [{ description: 'A' }, { description: 'B' }],
    })
    expect(describeDataType(stored!)).toEqual({ name: 'Plain', derivation: 'enumerated', values: ['A', 'B'] })
  })

  it('refuses a value out of the base range, two names with one value, and a base that is not an integer', async () => {
    const outOfRange = await apply([
      { ...spec, name: 'Wide', values: [{ name: 'A', value: 256 }], initialValue: undefined },
    ])
    expect(outOfRange.errors).toEqual(['data type "Wide": "A" = 256 is out of range for USINT (0..255).'])

    const twice = await apply([
      {
        ...spec,
        name: 'Twice',
        values: [
          { name: 'A', value: 1 },
          { name: 'B', value: 1 },
        ],
        initialValue: undefined,
      },
    ])
    expect(twice.errors).toEqual(['data type "Twice": "B" and "A" both have the value 1.'])

    const real = await apply([{ ...spec, name: 'Real', baseType: 'REAL', values: ['A'], initialValue: undefined }])
    expect(real.errors.join(' ')).toContain('base type "REAL" is not an integer or bit-string type')

    for (const name of ['Wide', 'Twice', 'Real']) {
      expect(dataTypesIn().some((type) => type.name === name)).toBe(false)
    }
  })
})
