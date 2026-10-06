import {
  defaultCustomNodesStyles,
  nodesBuilder,
} from '@root/frontend/components/_atoms/graphical-editor/ladder/node-builders'
import {
  DEFAULT_EXECUTE_CONNECTOR_Y,
  DEFAULT_EXECUTE_WIDTH,
  executeHeight,
} from '@root/frontend/components/_atoms/graphical-editor/ladder/utils/constants'
import {
  BlockNode,
  BlockVariant,
  CoilNode,
  ContactNode,
  ExecuteNode,
  LadderBlockConnectedVariables,
  ParallelNode,
  PowerRailNode,
  VariableNode,
} from '@root/frontend/components/_atoms/graphical-editor/ladder/utils/types'
import { buildEdge } from '@root/frontend/components/_molecules/graphical-editor/ladder/rung/ladder-utils/edges'
import { updateDiagramElementsPosition } from '@root/frontend/components/_molecules/graphical-editor/ladder/rung/ladder-utils/elements/diagram'
import { LadderFlowType, RungLadderState } from '@root/frontend/store/slices'
import { newUuid } from '@root/frontend/utils/new-uuid'
import {
  classifyBlockVariables,
  rebuildVariablesForInputCount,
} from '@root/frontend/utils/PLC/extensible-block-variables'
import { Edge, Position } from '@xyflow/react'

import { readExecuteStCode } from '../../execute-plcopen'
import type { BlockSignature, BlockSignatureResolver } from '../block-signatures'
import { executeStCodeKey } from '../parse-xml-document'
import { asArray, asRecord, asString } from '../xml-node'
import type { XyPosition } from './geometry'
import { makeHandle, parsePositionXml, toNumber } from './geometry'
import { reduceSeriesParallel, SeriesParallel, SeriesParallelWire, SINK, SOURCE } from './series-parallel'

type LadderParsedNode = PowerRailNode | ContactNode | CoilNode | BlockNode<BlockVariant> | VariableNode | ExecuteNode

// Reverse of xml-generator/old-editor/language/ladder-xml.ts. Greenfield (no
// PLCopen import reference existed anywhere before this) — reconstructed by
// reading that generator's findConnections/blockToXml/etc. in full.
//
// Handle ids are literal and stable in this dialect (unlike FBD's invented
// sentinels): power rails use "left-rail"/"right-rail", contacts/coils/leaf
// variable nodes use "input"/"output", blocks use their formal parameter
// names — confirmed directly from the generator (leftRailToXML/
// contactToXML/coilToXml never derive these from anything else).
const RAIL_OUTPUT_HANDLE = 'left-rail'
const RAIL_INPUT_HANDLE = 'right-rail'
const LEAF_INPUT_HANDLE = 'input'
const LEAF_OUTPUT_HANDLE = 'output'

// A plain function's single unnamed return pin has the domain handle id
// 'OUT', which the generator's findConnections collapses to an empty
// `@formalParameter` string on export (`sourceHandle === 'OUT' ? '' : ...`,
// ladder-xml.ts) — reversed here. `@formalParameter` is otherwise always
// present on a <connection> built by findConnections (rightPowerRail/
// contact/coil/block); it is omitted entirely only on the one bespoke path
// where a block's input pin is wired directly to a named <inVariable> node
// (blockToXml's "connected to an existing variable node" branch) — that
// case has no attribute to read at all, so its source handle defaults to
// the leaf output handle below.
const UNNAMED_FUNCTION_RETURN_HANDLE = 'OUT'

// A contact's/coil's own `<variable>Name</variable>` text child shares its
// tag name with the interface/block-pin `<variable>` LISTS the shared
// parser config (parse-xml-document.ts) always force-arrays — so it arrives
// here wrapped in a one-item array, not a plain string. Unwrap defensively.
function parseBoundVariableName(value: unknown): string {
  // Array.isArray narrows `unknown` to `any[]`, not `unknown[]` — re-widen
  // explicitly so the extracted element stays type-safe.
  const first: unknown = Array.isArray(value) ? (value as unknown[])[0] : value
  return asString(first)
}

// A block's <connection> (or contact/coil/rail's) may reference a node that
// appears later in the XML, so all nodes are built first and edges are
// resolved in a second pass against this pending list.
interface PendingEdge {
  targetNumericId: string
  targetHandle: string
  sourceRefLocalId: string
  sourceFormalParameter: string | undefined
}

function parseConnectionXml(connXml: unknown, targetNumericId: string, targetHandle: string): PendingEdge {
  const conn = asRecord(connXml)
  const hasFormalParameter = '@formalParameter' in conn
  const raw = asString(conn['@formalParameter'])
  return {
    targetNumericId,
    targetHandle,
    sourceRefLocalId: asString(conn['@refLocalId']),
    sourceFormalParameter: hasFormalParameter ? (raw === '' ? UNNAMED_FUNCTION_RETURN_HANDLE : raw) : undefined,
  }
}

// Rails are the one exception to this file's `TYPE-<localId>` id convention.
// The rung layout resolves them by prefix — `id.startsWith('left-rail')` /
// `'right-rail'` (see changeRailBounds and the handle-branch helpers) — so a
// differently-prefixed id makes an imported rung's right rail invisible to the
// layout: it never repositions, and elements added afterwards run straight
// past it.
function parseLeftRailXml(entry: Record<string, unknown>): PowerRailNode {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const outputHandle = makeHandle(
    RAIL_OUTPUT_HANDLE,
    'source',
    Position.Right,
    position,
    asRecord(entry.connectionPointOut).relPosition,
  )

  return {
    id: `left-rail-${numericId}`,
    type: 'powerRail',
    position,
    width: toNumber(entry['@width']),
    height: toNumber(entry['@height']),
    draggable: true,
    selectable: true,
    data: {
      handles: [outputHandle],
      inputHandles: [],
      outputHandles: [outputHandle],
      inputConnector: undefined,
      outputConnector: outputHandle,
      numericId,
      variable: { name: '' },
      executionOrder: 0,
      draggable: true,
      selectable: true,
      deletable: true,
      variant: 'left',
    },
  }
}

function parseRightRailXml(entry: Record<string, unknown>): { node: PowerRailNode; pendingEdges: PendingEdge[] } {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const connIn = asRecord(entry.connectionPointIn)
  const inputHandle = makeHandle(RAIL_INPUT_HANDLE, 'target', Position.Left, position, connIn.relPosition)
  const pendingEdges = asArray(connIn.connection).map((connRaw) =>
    parseConnectionXml(connRaw, numericId, RAIL_INPUT_HANDLE),
  )

  const node: PowerRailNode = {
    id: `right-rail-${numericId}`,
    type: 'powerRail',
    position,
    width: toNumber(entry['@width']),
    height: toNumber(entry['@height']),
    draggable: true,
    selectable: true,
    data: {
      handles: [inputHandle],
      inputHandles: [inputHandle],
      outputHandles: [],
      inputConnector: inputHandle,
      outputConnector: undefined,
      numericId,
      variable: { name: '' },
      executionOrder: 0,
      draggable: true,
      selectable: true,
      deletable: true,
      variant: 'right',
    },
  }

  return { node, pendingEdges }
}

// @negated/@edge(/@storage for coils) are independent XML attributes mapped
// onto one mutually-exclusive domain variant enum; the generator only ever
// emits one of them at a time (its own ternary chains enforce that), but
// nothing in the XML shape prevents a foreign document from setting more
// than one — priority storage > negated > edge is an arbitrary, documented
// call for that (currently unseen-in-fixtures) case.
function parseCoilVariant(
  entry: Record<string, unknown>,
): 'default' | 'negated' | 'risingEdge' | 'fallingEdge' | 'set' | 'reset' {
  const storage = entry['@storage']
  if (storage === 'set') return 'set'
  if (storage === 'reset') return 'reset'
  if (asString(entry['@negated']) === 'true') return 'negated'
  if (entry['@edge'] === 'rising') return 'risingEdge'
  if (entry['@edge'] === 'falling') return 'fallingEdge'
  return 'default'
}

function parseContactVariant(entry: Record<string, unknown>): 'default' | 'negated' | 'risingEdge' | 'fallingEdge' {
  if (asString(entry['@negated']) === 'true') return 'negated'
  if (entry['@edge'] === 'rising') return 'risingEdge'
  if (entry['@edge'] === 'falling') return 'fallingEdge'
  return 'default'
}

function parseContactXml(entry: Record<string, unknown>): { node: ContactNode; pendingEdges: PendingEdge[] } {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const connIn = asRecord(entry.connectionPointIn)
  const inputHandle = makeHandle(LEAF_INPUT_HANDLE, 'target', Position.Left, position, connIn.relPosition)
  const outputHandle = makeHandle(
    LEAF_OUTPUT_HANDLE,
    'source',
    Position.Right,
    position,
    asRecord(entry.connectionPointOut).relPosition,
  )
  const pendingEdges = asArray(connIn.connection).map((connRaw) =>
    parseConnectionXml(connRaw, numericId, LEAF_INPUT_HANDLE),
  )

  const node: ContactNode = {
    id: `CONTACT-${numericId}`,
    type: 'contact',
    position,
    width: toNumber(entry['@width']),
    height: toNumber(entry['@height']),
    draggable: true,
    selectable: true,
    data: {
      handles: [inputHandle, outputHandle],
      inputHandles: [inputHandle],
      outputHandles: [outputHandle],
      inputConnector: inputHandle,
      outputConnector: outputHandle,
      numericId,
      variable: { name: parseBoundVariableName(entry.variable) },
      executionOrder: 0,
      draggable: true,
      selectable: true,
      deletable: true,
      variant: parseContactVariant(entry),
    },
  }

  return { node, pendingEdges }
}

function parseCoilXml(entry: Record<string, unknown>): { node: CoilNode; pendingEdges: PendingEdge[] } {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const connIn = asRecord(entry.connectionPointIn)
  const inputHandle = makeHandle(LEAF_INPUT_HANDLE, 'target', Position.Left, position, connIn.relPosition)
  const outputHandle = makeHandle(
    LEAF_OUTPUT_HANDLE,
    'source',
    Position.Right,
    position,
    asRecord(entry.connectionPointOut).relPosition,
  )
  const pendingEdges = asArray(connIn.connection).map((connRaw) =>
    parseConnectionXml(connRaw, numericId, LEAF_INPUT_HANDLE),
  )

  const node: CoilNode = {
    id: `COIL-${numericId}`,
    type: 'coil',
    position,
    width: toNumber(entry['@width']),
    height: toNumber(entry['@height']),
    draggable: true,
    selectable: true,
    data: {
      handles: [inputHandle, outputHandle],
      inputHandles: [inputHandle],
      outputHandles: [outputHandle],
      inputConnector: inputHandle,
      outputConnector: outputHandle,
      numericId,
      variable: { name: parseBoundVariableName(entry.variable) },
      executionOrder: 0,
      draggable: true,
      selectable: true,
      deletable: true,
      variant: parseCoilVariant(entry),
    },
  }

  return { node, pendingEdges }
}

// One <variable formalParameter="X"> per declared pin (never duplicated
// per-edge the way FBD's block inputs are — findConnections nests every
// matching <connection> inside that single variable's connectionPointIn),
// so — unlike fbd-xml.ts — no formalParameter-grouping/dedup is needed here.
function parseBlockXml(entry: Record<string, unknown>): { node: BlockNode<BlockVariant>; pendingEdges: PendingEdge[] } {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const instanceName = entry['@instanceName']
  const isFunctionBlock = typeof instanceName === 'string'
  const typeName = asString(entry['@typeName'])

  const inputHandles: BlockNode<BlockVariant>['data']['inputHandles'] = []
  const pendingEdges: PendingEdge[] = []

  for (const varRaw of asArray(asRecord(entry.inputVariables).variable)) {
    const v = asRecord(varRaw)
    const formalParameter = asString(v['@formalParameter'])
    const connIn = asRecord(v.connectionPointIn)
    inputHandles.push(makeHandle(formalParameter, 'target', Position.Left, position, connIn.relPosition))
    for (const connRaw of asArray(connIn.connection)) {
      pendingEdges.push(parseConnectionXml(connRaw, numericId, formalParameter))
    }
  }

  // A plain function's unnamed return pin is declared here as formalParameter=""
  // (see UNNAMED_FUNCTION_RETURN_HANDLE) — translate its own handle id the
  // same way other nodes' connections referencing it will expect.
  const outputHandles: BlockNode<BlockVariant>['data']['outputHandles'] = asArray(
    asRecord(entry.outputVariables).variable,
  ).map((varRaw) => {
    const v = asRecord(varRaw)
    const raw = asString(v['@formalParameter'])
    const handleId = raw === '' ? UNNAMED_FUNCTION_RETURN_HANDLE : raw
    const connOut = asRecord(v.connectionPointOut)
    return makeHandle(handleId, 'source', Position.Right, position, connOut.relPosition)
  })

  const variableName = isFunctionBlock ? asString(instanceName) : typeName

  const node: BlockNode<BlockVariant> = {
    id: `BLOCK-${numericId}`,
    type: 'block',
    position,
    width: toNumber(entry['@width']),
    height: toNumber(entry['@height']),
    draggable: true,
    selectable: true,
    data: {
      handles: [...inputHandles, ...outputHandles],
      inputHandles,
      outputHandles,
      inputConnector: inputHandles[0],
      outputConnector: outputHandles[0],
      numericId,
      variable: { name: variableName },
      executionOrder: toNumber(entry['@executionOrderId']),
      draggable: true,
      selectable: true,
      deletable: true,
      // Full class/type per pin can't be recovered from the LD XML alone
      // (it only ever names pins, never their IEC class/type) — an honest
      // documented gap, same as the FBD importer's block variant.
      variant: {
        name: typeName,
        type: isFunctionBlock ? 'function-block' : 'function',
        variables: [],
        documentation: '',
        extensible: false,
      },
      executionControl: false,
      lockExecutionControl: false,
      connectedVariables: [],
    },
  }

  return { node, pendingEdges }
}

/** An `EN` / `ENO` handle for a file that declared neither. */
function makeExecuteFallbackHandle(id: 'EN' | 'ENO', position: XyPosition) {
  const side = id === 'EN' ? Position.Left : Position.Right
  const relPosition = { '@x': id === 'EN' ? 0 : DEFAULT_EXECUTE_WIDTH, '@y': DEFAULT_EXECUTE_CONNECTOR_Y }
  return makeHandle(id, id === 'EN' ? 'target' : 'source', side, position, relPosition, {
    top: DEFAULT_EXECUTE_CONNECTOR_Y,
    ...(id === 'EN' ? { left: 0 } : { right: 0 }),
  })
}

/**
 * Rebuild an Execute ("ST Block") element from a `<block typeName="EXECUTE">`.
 *
 * PLCopen has no inline-ST element, so the snippet rides in an `<addData>`
 * under 3S's `.../plcopenxml/stcode` URI — the same shape CODESYS writes, so
 * their exports import here too. See `utils/PLC/execute-plcopen.ts`.
 *
 * The `EN`/`ENO` pins are ordinary formal parameters, so connections rebuild
 * through exactly the same `parseConnectionXml` path as any other block.
 */
function parseExecuteXml(
  entry: Record<string, unknown>,
  code: string,
): { node: ExecuteNode; pendingEdges: PendingEdge[] } {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const pendingEdges: PendingEdge[] = []

  const inputHandles: ExecuteNode['data']['inputHandles'] = []
  for (const varRaw of asArray(asRecord(entry.inputVariables).variable)) {
    const v = asRecord(varRaw)
    const formalParameter = asString(v['@formalParameter'])
    const connIn = asRecord(v.connectionPointIn)
    // `style.top` is what places the handle's DOM element, and React Flow
    // draws edges to the DOM position — without it an imported box has its
    // wires meeting it at the element's vertical centre instead of the pin row.
    inputHandles.push(
      makeHandle(formalParameter, 'target', Position.Left, position, connIn.relPosition, {
        top: DEFAULT_EXECUTE_CONNECTOR_Y,
        left: 0,
      }),
    )
    for (const connRaw of asArray(connIn.connection)) {
      pendingEdges.push(parseConnectionXml(connRaw, numericId, formalParameter))
    }
  }

  // Same empty-formalParameter translation `parseBlockXml` applies, because
  // `parseConnectionXml` already resolves a consumer's sourceHandle that way.
  // Without it a foreign file declaring the output as formalParameter="" gets
  // a handle named '' and an ENO edge pointing at nothing, so the wire that
  // the file clearly draws does not render.
  const outputHandles: ExecuteNode['data']['outputHandles'] = asArray(asRecord(entry.outputVariables).variable).map(
    (varRaw) => {
      const v = asRecord(varRaw)
      const raw = asString(v['@formalParameter'])
      const connOut = asRecord(v.connectionPointOut)
      return makeHandle(
        raw === '' ? UNNAMED_FUNCTION_RETURN_HANDLE : raw,
        'source',
        Position.Right,
        position,
        connOut.relPosition,
        {
          top: DEFAULT_EXECUTE_CONNECTOR_Y,
          right: 0,
        },
      )
    },
  )

  // A file that declares typeName="EXECUTE" without EN/ENO still has to
  // produce a usable box: the rung layout reads `inputConnector` /
  // `outputConnector` to place whatever is inserted next to it, and an
  // undefined one crashes it. Nothing we write omits them — this covers
  // hand-edited and foreign files.
  if (inputHandles.length === 0) inputHandles.push(makeExecuteFallbackHandle('EN', position))
  if (outputHandles.length === 0) outputHandles.push(makeExecuteFallbackHandle('ENO', position))

  // `||` and not `??`: toNumber yields 0 for an absent or unparseable
  // attribute, and a 0-sized box is exactly what needs the fallback. CODESYS
  // omits width/height entirely, so this is its normal path.
  const width = toNumber(entry['@width']) || DEFAULT_EXECUTE_WIDTH
  const height = toNumber(entry['@height']) || executeHeight(code === '' ? 0 : code.split('\n').length)

  const node: ExecuteNode = {
    id: `EXECUTE-${numericId}`,
    type: 'execute',
    position,
    width,
    height,
    draggable: true,
    selectable: true,
    data: {
      handles: [...inputHandles, ...outputHandles],
      inputHandles,
      outputHandles,
      inputConnector: inputHandles[0],
      outputConnector: outputHandles[0],
      numericId,
      code,
      variable: { name: '' },
      executionOrder: toNumber(entry['@executionOrderId']),
      draggable: true,
      selectable: true,
      deletable: true,
    },
  }

  return { node, pendingEdges }
}

function parseInVariableXml(entry: Record<string, unknown>): VariableNode {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const outputHandle = makeHandle(
    LEAF_OUTPUT_HANDLE,
    'source',
    Position.Right,
    position,
    asRecord(entry.connectionPointOut).relPosition,
  )

  return {
    id: `INPUT-VARIABLE-${numericId}`,
    type: 'variable',
    position,
    width: toNumber(entry['@width']),
    height: toNumber(entry['@height']),
    draggable: true,
    selectable: true,
    data: {
      handles: [outputHandle],
      inputHandles: [],
      outputHandles: [outputHandle],
      inputConnector: undefined,
      outputConnector: outputHandle,
      numericId,
      variable: { name: asString(entry.expression) },
      executionOrder: 0,
      draggable: true,
      selectable: true,
      deletable: true,
      variant: 'input',
      // Which block/pin this literal feeds can't be recovered here (only
      // the block's own <inputVariables> entry names its source by
      // refLocalId, not the reverse) — left as an honest placeholder; the
      // edge built from that block's connection is the source of truth.
      block: {
        id: '',
        handleId: '',
        variableType: { name: '', class: '', type: { definition: 'base-type', value: '' } },
      },
    },
  }
}

function parseOutVariableXml(entry: Record<string, unknown>): { node: VariableNode; pendingEdges: PendingEdge[] } {
  const numericId = asString(entry['@localId'])
  const position = parsePositionXml(entry.position)
  const connIn = asRecord(entry.connectionPointIn)
  const inputHandle = makeHandle(LEAF_INPUT_HANDLE, 'target', Position.Left, position, connIn.relPosition)
  const connections = asArray(connIn.connection)
  const pendingEdges = connections.map((connRaw) => parseConnectionXml(connRaw, numericId, LEAF_INPUT_HANDLE))

  // outVariableToXML always emits exactly one connection, built directly
  // from data.block.{id,handleId} rather than through findConnections — the
  // one place the generator trusts that bookkeeping over the edge graph.
  // Reversed here: refLocalId/formalParameter identify the source block by
  // numericId, but `block.id` wants the block's own xyflow id, which isn't
  // known until the second pass — left blank and not otherwise relied upon
  // (the edge itself is the source of truth for wiring).
  const firstConnection = asRecord(connections[0])
  const blockHandleId = asString(firstConnection['@formalParameter'])

  return {
    node: {
      id: `OUTPUT-VARIABLE-${numericId}`,
      type: 'variable',
      position,
      width: toNumber(entry['@width']),
      height: toNumber(entry['@height']),
      draggable: true,
      selectable: true,
      data: {
        handles: [inputHandle],
        inputHandles: [inputHandle],
        outputHandles: [],
        inputConnector: inputHandle,
        outputConnector: undefined,
        numericId,
        variable: { name: asString(entry.expression) },
        executionOrder: 0,
        draggable: true,
        selectable: true,
        deletable: true,
        variant: 'output',
        block: {
          id: '',
          handleId: blockHandleId,
          variableType: { name: '', class: '', type: { definition: 'base-type', value: '' } },
        },
      },
    },
    pendingEdges,
  }
}

// Simple union-find for grouping the flat XML's nodes back into rungs (see
// parseLadderXml below for why this is necessary rather than a positional
// grouping).
class UnionFind {
  private readonly parent = new Map<string, string>()

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/**
 * Shift a rung's nodes vertically by `dy`, keeping handle geometry in step.
 *
 * Mutates the freshly-parsed nodes rather than rebuilding them: `data` is a
 * discriminated union whose members differ, and every node's handles are
 * reached the same way regardless. `inputConnector` / `outputConnector` alias
 * the same handle objects, so moving those objects updates every view of them.
 */
function translateRungY(rungNodes: LadderParsedNode[], dy: number): void {
  if (dy === 0) return
  // `handles` holds the same objects as `inputHandles` / `outputHandles`, so
  // track identity — moving one twice would double the shift.
  const moved = new Set<object>()
  for (const node of rungNodes) {
    node.position = { x: node.position.x, y: node.position.y + dy }
    const data: unknown = node.data
    if (typeof data !== 'object' || data === null) continue
    for (const key of ['handles', 'inputHandles', 'outputHandles'] as const) {
      if (!(key in data)) continue
      const handles = (data as Record<string, unknown>)[key]
      if (!Array.isArray(handles)) continue
      for (const handle of handles) {
        if (typeof handle !== 'object' || handle === null || !('glbPosition' in handle)) continue
        if (moved.has(handle)) continue
        moved.add(handle)
        const { glbPosition } = handle as { glbPosition: { x: number; y: number } }
        glbPosition.y += dy
      }
    }
  }
}

export interface LadderParseContext {
  resolveBlock: BlockSignatureResolver
}

const NO_SIGNATURES: LadderParseContext = { resolveBlock: () => undefined }

// Bounds the editor gives a new rung (ladder/index.tsx, handleAddNewRung).
const NEW_RUNG_BOUNDS: [number, number] = [300, 100]

const EXECUTION_CONTROL_PINS = new Set(['EN', 'ENO'])

type NativeElement = ContactNode | CoilNode | BlockNode<BlockVariant> | ExecuteNode
type RailNode = ReturnType<typeof nodesBuilder.powerRail>
type NativeNode = NativeElement | RailNode | ParallelNode

interface Endpoint {
  node: NativeNode
  handle: string
}

type RebuildResult = { ok: true; rung: RungLadderState } | { ok: false; reason: string }

interface ImportedLink {
  edge: Edge
  source: LadderParsedNode
  target: LadderParsedNode
}

const isParallel = (node: NativeNode): node is ParallelNode => node.type === 'parallel'
const isBlock = (node: LadderParsedNode): node is BlockNode<BlockVariant> => node.type === 'block'
const isRail = (node: LadderParsedNode): node is PowerRailNode => node.type === 'powerRail'
const isVariable = (node: LadderParsedNode): node is VariableNode => node.type === 'variable'
const isContact = (node: LadderParsedNode): node is ContactNode => node.type === 'contact'
const isCoil = (node: LadderParsedNode): node is CoilNode => node.type === 'coil'
const isExecute = (node: LadderParsedNode): node is ExecuteNode => node.type === 'execute'

// The XML only names the pins it wired, so an undefined type keeps whatever pins it did name.
function signatureFromXmlPins(block: BlockNode<BlockVariant>): BlockSignature {
  const pins = (handles: { id?: string | null }[], pinClass: string) =>
    handles
      .map((handle) => handle.id ?? '')
      .filter((id) => id !== '' && !EXECUTION_CONTROL_PINS.has(id.toUpperCase()))
      .map((id) => ({ name: id, class: pinClass, type: { definition: 'generic-type', value: 'ANY' } }))
  return {
    name: block.data.variant.name,
    type: block.data.variant.type,
    variables: [...pins(block.data.inputHandles, 'input'), ...pins(block.data.outputHandles, 'output')],
    documentation: '',
    extensible: false,
  }
}

// A library signature only declares the default inputs of an extensible block (IN1, IN2 for ADD).
function fitExtensibleInputs(signature: BlockSignature, imported: BlockNode<BlockVariant>): BlockSignature {
  if (!signature.extensible) return signature
  const xmlInputs = imported.data.inputHandles.map((handle) => ({
    name: (handle.id ?? '').toUpperCase(),
    class: 'input',
    type: { definition: 'generic-type', value: 'ANY' },
  }))
  const xmlCount = classifyBlockVariables(xmlInputs).extensibleInputs.length
  const { fixedInputs, extensibleInputs } = classifyBlockVariables(signature.variables)
  if (xmlCount <= extensibleInputs.length) return signature
  return { ...signature, variables: rebuildVariablesForInputCount(signature.variables, fixedInputs.length + xmlCount) }
}

function buildNativeBlock(
  pouName: string,
  imported: BlockNode<BlockVariant>,
  context: LadderParseContext,
  warnings: string[],
): BlockNode<BlockVariant> {
  let signature = context.resolveBlock(imported.data.variant.name)
  if (!signature) {
    warnings.push(
      `POU "${pouName}": block type "${imported.data.variant.name}" is not defined in the project or its libraries, its pins were taken from the XML`,
    )
    signature = signatureFromXmlPins(imported)
  }
  signature = fitExtensibleInputs(signature, imported)
  const block: BlockNode<BlockVariant> = nodesBuilder.block({
    id: imported.id,
    posX: 0,
    posY: 0,
    handleX: 0,
    handleY: 0,
    variant: signature,
    executionControl: imported.data.inputHandles.some((handle) => handle.id?.toUpperCase() === 'EN'),
  })
  return {
    ...block,
    selected: false,
    data: {
      ...block.data,
      numericId: imported.data.numericId,
      executionOrder: imported.data.executionOrder,
      variable: { name: imported.data.variant.type === 'function-block' ? imported.data.variable.name : '' },
    },
  }
}

function buildNativeContact(imported: ContactNode): ContactNode {
  const node = nodesBuilder.contact({
    id: imported.id,
    posX: 0,
    posY: 0,
    handleX: 0,
    handleY: 0,
    variant: imported.data.variant,
  })
  return { ...node, data: { ...node.data, numericId: imported.data.numericId, variable: imported.data.variable } }
}

function buildNativeCoil(imported: CoilNode): CoilNode {
  const node = nodesBuilder.coil({
    id: imported.id,
    posX: 0,
    posY: 0,
    handleX: 0,
    handleY: 0,
    variant: imported.data.variant,
  })
  return { ...node, data: { ...node.data, numericId: imported.data.numericId, variable: imported.data.variable } }
}

// An Execute ("ST Block") element is a series element like a contact: EN in, ENO out, and its code carried over.
function buildNativeExecute(imported: ExecuteNode): ExecuteNode {
  const node = nodesBuilder.execute({
    id: imported.id,
    posX: 0,
    posY: 0,
    handleX: 0,
    handleY: 0,
    code: imported.data.code,
  })
  return {
    ...node,
    data: { ...node.data, numericId: imported.data.numericId, executionOrder: imported.data.executionOrder },
  }
}

// XML pin names are matched case-insensitively (IEC identifiers are), then spelled as the block spells them.
function findPin(handles: { id?: string | null }[], xmlPin: string | null | undefined): string | undefined {
  const wanted = (xmlPin ?? '').toUpperCase()
  return handles.find((handle) => handle.id?.toUpperCase() === wanted)?.id ?? undefined
}

// Mirrors the handle overrides startParallelConnection applies to a parallel nested at the start or end of a
// parallel path: there the inner OPEN receives on its top handle and the inner CLOSE sends from its top handle.
function connectEndpoint(edges: Edge[], from: Endpoint, to: NativeNode, targetHandle: string): void {
  let sourceHandle = from.handle
  let handle = targetHandle
  const source = from.node
  if (isParallel(source) && isParallel(to)) {
    if (
      source.data.type === 'open' &&
      to.data.type === 'open' &&
      from.handle === source.data.parallelOutputConnector?.id
    ) {
      handle = to.data.parallelInputConnector?.id ?? handle
    }
    if (
      source.data.type === 'close' &&
      to.data.type === 'close' &&
      targetHandle === to.data.parallelInputConnector?.id
    ) {
      sourceHandle = source.data.parallelOutputConnector?.id ?? sourceHandle
    }
  }
  edges.push(buildEdge(source.id, to.id, { sourceHandle, targetHandle: handle }))
}

function buildParallelPair(): { open: ParallelNode; close: ParallelNode } {
  const origin = { posX: 0, posY: 0, handleX: 0, handleY: 0 }
  const open = nodesBuilder.parallel({ id: `PARALLEL_OPEN_${newUuid()}`, type: 'open', ...origin })
  const close = nodesBuilder.parallel({ id: `PARALLEL_CLOSE_${newUuid()}`, type: 'close', ...origin })
  open.data.parallelCloseReference = close.id
  close.data.parallelOpenReference = open.id
  return { open, close }
}

// Emits nodes in the order the editor's own insertions leave them (OPEN, serial path, parallel path, CLOSE): the
// layout walks the array and positions each node from predecessors it has already placed.
function emitSeriesParallel(
  expr: SeriesParallel<NativeElement>,
  from: Endpoint,
  nodes: NativeNode[],
  edges: Edge[],
): Endpoint {
  switch (expr.kind) {
    case 'wire':
      return from
    case 'leaf': {
      const node = expr.value
      nodes.push(node)
      connectEndpoint(edges, from, node, node.data.inputConnector?.id ?? LEAF_INPUT_HANDLE)
      return { node, handle: node.data.outputConnector?.id ?? LEAF_OUTPUT_HANDLE }
    }
    case 'series':
      return expr.items.reduce((endpoint, item) => emitSeriesParallel(item, endpoint, nodes, edges), from)
    case 'parallel': {
      const [serialBranch, ...parallelBranches] = expr.branches
      const { open, close } = buildParallelPair()
      nodes.push(open)
      connectEndpoint(edges, from, open, open.data.inputConnector?.id ?? LEAF_INPUT_HANDLE)
      const serialEnd = emitSeriesParallel(
        serialBranch,
        { node: open, handle: open.data.outputConnector?.id ?? '' },
        nodes,
        edges,
      )
      // More than two branches nest, as they do when a branch is added under a parallel path in the editor.
      const parallelEnd = emitSeriesParallel(
        parallelBranches.length === 1 ? parallelBranches[0] : { kind: 'parallel', branches: parallelBranches },
        { node: open, handle: open.data.parallelOutputConnector?.id ?? '' },
        nodes,
        edges,
      )
      nodes.push(close)
      connectEndpoint(edges, serialEnd, close, close.data.inputConnector?.id ?? '')
      connectEndpoint(edges, parallelEnd, close, close.data.parallelInputConnector?.id ?? '')
      return { node: close, handle: close.data.outputConnector?.id ?? '' }
    }
  }
}

/**
 * Put a rung's nodes in electrical order: left rail first, each element in
 * signal-flow order, right rail last.
 *
 * The parse builds nodes grouped by XML element type — every `<contact>`, then
 * every `<coil>`, then every `<block>` — because that is the shape
 * fast-xml-parser hands over. The ladder editor reads a rung's node array as
 * its serial spine, though: `appendSerialConnection` and `getPreviousElement`
 * both take "the entry before this one in the array" to be the electrical
 * predecessor. Fed a type-grouped array, inserting an element wires it to
 * whatever happened to be parsed before it — typically the right power rail,
 * which has no output connector at all.
 *
 * Kahn's algorithm over the rung's own edges, tie-broken by X then parse order.
 * Newly-ready successors go to the front of the queue so a chain stays
 * contiguous — a parallel path's elements must not interleave with its
 * sibling's.
 */
function orderRungNodes(rungNodes: LadderParsedNode[], rungEdges: Edge[]): LadderParsedNode[] {
  const byId = new Map(rungNodes.map((node) => [node.id, node]))
  const parseIndex = new Map(rungNodes.map((node, index) => [node.id, index]))
  const inDegree = new Map(rungNodes.map((node) => [node.id, 0]))
  const successors = new Map<string, string[]>()

  for (const edge of rungEdges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) continue
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    const existing = successors.get(edge.source)
    if (existing) existing.push(edge.target)
    else successors.set(edge.source, [edge.target])
  }

  const compare = (a: LadderParsedNode, b: LadderParsedNode): number =>
    a.position.x - b.position.x || (parseIndex.get(a.id) ?? 0) - (parseIndex.get(b.id) ?? 0)

  const queue = rungNodes.filter((node) => (inDegree.get(node.id) ?? 0) === 0).sort(compare)
  const ordered: LadderParsedNode[] = []
  const placed = new Set<string>()

  while (queue.length > 0) {
    const node = queue.shift()
    if (!node) break
    ordered.push(node)
    placed.add(node.id)

    const unlocked: LadderParsedNode[] = []
    for (const successorId of successors.get(node.id) ?? []) {
      const remaining = (inDegree.get(successorId) ?? 0) - 1
      inDegree.set(successorId, remaining)
      if (remaining !== 0) continue
      const successor = byId.get(successorId)
      if (successor) unlocked.push(successor)
    }
    queue.unshift(...unlocked.sort(compare))
  }

  // Ladder bodies are acyclic, so this only guards against a malformed file —
  // an unorderable node keeps its parse position rather than being dropped.
  for (const node of rungNodes) if (!placed.has(node.id)) ordered.push(node)

  return ordered
}

function buildNativeRails(rungId: string): { left: RailNode; right: RailNode } {
  const [width, height] = NEW_RUNG_BOUNDS
  const { powerRail } = defaultCustomNodesStyles
  const left = nodesBuilder.powerRail({
    id: `left-rail-${rungId}`,
    posX: 0,
    posY: height / 2 - powerRail.height / 2,
    connector: 'right',
    handleX: powerRail.width,
    handleY: height / 2,
  })
  const right = nodesBuilder.powerRail({
    id: `right-rail-${rungId}`,
    posX: width,
    posY: height / 2 - powerRail.height / 2,
    connector: 'left',
    handleX: width - powerRail.width,
    handleY: height / 2,
  })
  return { left, right }
}

/**
 * Rebuild one imported rung as the editor itself would have drawn it: blocks carry their real signature, the
 * literals and variables wired to their secondary pins become connected variables, fan-out/fan-in becomes
 * OPEN/CLOSE parallels, and every position comes from the editor's own layout rather than the XML's.
 */
function rebuildRung(
  pouName: string,
  rungId: string,
  imported: { nodes: LadderParsedNode[]; links: ImportedLink[] },
  context: LadderParseContext,
  warnings: string[],
): RebuildResult {
  const leftRails = imported.nodes.filter((node) => isRail(node) && node.data.variant === 'left')
  const rightRails = imported.nodes.filter((node) => isRail(node) && node.data.variant === 'right')
  if (leftRails.length !== 1 || rightRails.length !== 1) {
    return { ok: false, reason: 'it does not have exactly one left and one right power rail' }
  }
  const [leftRailId, rightRailId] = [leftRails[0].id, rightRails[0].id]

  const elements = new Map<string, NativeElement>()
  const blockWarnings: string[] = []
  for (const node of imported.nodes) {
    if (isBlock(node)) elements.set(node.id, buildNativeBlock(pouName, node, context, blockWarnings))
    else if (isContact(node)) elements.set(node.id, buildNativeContact(node))
    else if (isCoil(node)) elements.set(node.id, buildNativeCoil(node))
    else if (isExecute(node)) elements.set(node.id, buildNativeExecute(node))
  }

  const wires: SeriesParallelWire[] = []
  const connectedVariables = new Map<string, LadderBlockConnectedVariables>()
  const addConnectedVariable = (blockId: string, entry: LadderBlockConnectedVariables[number]) => {
    connectedVariables.set(blockId, [...(connectedVariables.get(blockId) ?? []), entry])
  }

  for (const { edge, source, target } of imported.links) {
    if (isVariable(source) || isVariable(target)) {
      const direction = isVariable(source) ? 'input' : 'output'
      const variableNode = direction === 'input' ? source : target
      const block = elements.get(direction === 'input' ? target.id : source.id)
      if (!isVariable(variableNode) || !block || !isBlock(block)) {
        return { ok: false, reason: 'a variable box is wired to something other than a block pin' }
      }
      const handles = direction === 'input' ? block.data.inputHandles : block.data.outputHandles
      const mainPin = direction === 'input' ? block.data.inputConnector?.id : block.data.outputConnector?.id
      const pin = findPin(handles, direction === 'input' ? edge.targetHandle : edge.sourceHandle)
      if (!pin) {
        const xmlPin = (direction === 'input' ? edge.targetHandle : edge.sourceHandle) ?? ''
        return { ok: false, reason: `block "${block.data.variant.name}" has no pin "${xmlPin}"` }
      }
      if (pin === mainPin) {
        return {
          ok: false,
          reason: `block "${block.data.variant.name}" has a variable box on the pin the rung runs through`,
        }
      }
      const { name } = variableNode.data.variable
      if (name !== '') {
        addConnectedVariable(block.id, {
          handleId: pin,
          handleTableId: block.data.variant.variables.find((variable) => variable.name === pin)?.id,
          type: direction,
          variable: { name },
        })
      }
      continue
    }

    const endpointOf = (node: LadderParsedNode) =>
      node.id === leftRailId ? SOURCE : node.id === rightRailId ? SINK : elements.get(node.id)
    const from = endpointOf(source)
    const to = endpointOf(target)
    if (!from || !to || from === SINK || to === SOURCE) {
      return { ok: false, reason: 'a connection runs into a power rail from the wrong side' }
    }
    if (
      from !== SOURCE &&
      isBlock(from) &&
      edge.sourceHandle !== LEAF_OUTPUT_HANDLE &&
      findPin(from.data.outputHandles, edge.sourceHandle) !== from.data.outputConnector?.id
    ) {
      return {
        ok: false,
        reason: `elements are wired to the secondary output "${edge.sourceHandle}" of block "${from.data.variant.name}"`,
      }
    }
    if (to !== SINK && isBlock(to) && findPin(to.data.inputHandles, edge.targetHandle) !== to.data.inputConnector?.id) {
      return {
        ok: false,
        reason: `elements are wired to the secondary input "${edge.targetHandle}" of block "${to.data.variant.name}"`,
      }
    }
    wires.push({ from: from === SOURCE ? SOURCE : from.id, to: to === SINK ? SINK : to.id })
  }

  const positionOf = new Map(imported.nodes.map((node) => [node.id, node.position]))
  const reduced = reduceSeriesParallel(
    [...elements.values()].map((element) => ({ id: element.id, value: element })),
    wires,
    (element) => {
      const position = positionOf.get(element.id) ?? { x: 0, y: 0 }
      return position.y * 1e6 + position.x
    },
  )
  if (!reduced.ok) return reduced

  for (const [blockId, entries] of connectedVariables) {
    const block = elements.get(blockId)
    if (block && isBlock(block))
      elements.set(blockId, { ...block, data: { ...block.data, connectedVariables: entries } })
  }
  const withConnectedVariables = (expr: SeriesParallel<NativeElement>): SeriesParallel<NativeElement> => {
    switch (expr.kind) {
      case 'wire':
        return expr
      case 'leaf':
        return { kind: 'leaf', value: elements.get(expr.value.id) ?? expr.value }
      case 'series':
        return { kind: 'series', items: expr.items.map(withConnectedVariables) }
      case 'parallel':
        return { kind: 'parallel', branches: expr.branches.map(withConnectedVariables) }
    }
  }

  const { left, right } = buildNativeRails(rungId)
  const nodes: NativeNode[] = [left]
  const edges: Edge[] = []
  const end = emitSeriesParallel(
    withConnectedVariables(reduced.expr),
    { node: left, handle: RAIL_OUTPUT_HANDLE },
    nodes,
    edges,
  )
  connectEndpoint(edges, end, right, RAIL_INPUT_HANDLE)
  nodes.push(right)

  const rung: RungLadderState = {
    id: rungId,
    comment: '',
    defaultBounds: [...NEW_RUNG_BOUNDS],
    reactFlowViewport: [...NEW_RUNG_BOUNDS],
    selectedNodes: [],
    nodes,
    edges,
  }
  const laidOut = updateDiagramElementsPosition(rung, NEW_RUNG_BOUNDS)
  warnings.push(...blockWarnings)
  return { ok: true, rung: { ...rung, nodes: laidOut.nodes, edges: laidOut.edges } }
}

function withResolvedSignature(
  pouName: string,
  node: LadderParsedNode,
  context: LadderParseContext,
  warnings: string[],
): LadderParsedNode {
  if (!isBlock(node)) return node
  const { variant, executionControl, lockExecutionControl } = buildNativeBlock(pouName, node, context, warnings).data
  return { ...node, data: { ...node.data, variant, executionControl, lockExecutionControl } }
}

export function parseLadderXml(
  pouName: string,
  ldXml: unknown,
  context: LadderParseContext = NO_SIGNATURES,
  /**
   * Untrimmed `<STCode>` payloads keyed by POU name and `@localId`, from a second parse — see
   * `parse-xml-document.ts`. The main parse trims text nodes, which would
   * eat an Execute snippet's first-line indentation and trailing newline.
   * Absent (tests, callers that don't care) falls back to the trimmed text.
   */
  executeStCode: ReadonlyMap<string, string> = new Map(),
): { body: LadderFlowType; warnings: string[] } {
  const ld = asRecord(ldXml)
  const warnings: string[] = []
  const nodes: LadderParsedNode[] = []
  const pendingEdges: PendingEdge[] = []

  for (const entry of asArray(ld.leftPowerRail)) {
    const node = parseLeftRailXml(asRecord(entry))
    nodes.push(node)
  }
  for (const entry of asArray(ld.rightPowerRail)) {
    const { node, pendingEdges: edges } = parseRightRailXml(asRecord(entry))
    nodes.push(node)
    pendingEdges.push(...edges)
  }
  for (const entry of asArray(ld.contact)) {
    const { node, pendingEdges: edges } = parseContactXml(asRecord(entry))
    nodes.push(node)
    pendingEdges.push(...edges)
  }
  for (const entry of asArray(ld.coil)) {
    const { node, pendingEdges: edges } = parseCoilXml(asRecord(entry))
    nodes.push(node)
    pendingEdges.push(...edges)
  }
  for (const entry of asArray(ld.block)) {
    const record = asRecord(entry)
    // An Execute ("ST Block") element rides in as a <block> with
    // typeName="EXECUTE" — the shape CODESYS itself writes — so it has to be
    // split out here before the generic block path claims it as a function call.
    const trimmedCode = readExecuteStCode(record)
    const executeCode =
      trimmedCode === null
        ? null
        : (executeStCode.get(executeStCodeKey(pouName, asString(record['@localId']))) ?? trimmedCode)
    const { node, pendingEdges: edges } =
      executeCode === null ? parseBlockXml(record) : parseExecuteXml(record, executeCode)
    nodes.push(node)
    pendingEdges.push(...edges)
  }
  for (const entry of asArray(ld.inVariable)) {
    const node = parseInVariableXml(asRecord(entry))
    nodes.push(node)
  }
  for (const entry of asArray(ld.outVariable)) {
    const { node, pendingEdges: edges } = parseOutVariableXml(asRecord(entry))
    nodes.push(node)
    pendingEdges.push(...edges)
  }

  const nodeByNumericId = new Map(nodes.map((node) => [node.data.numericId, node]))

  const inOutCount = asArray(ld.inOutVariable).length
  if (inOutCount > 0) {
    warnings.push(`POU "${pouName}": ${inOutCount} LD inOutVariable node(s) are not supported, skipped`)
  }

  const links: ImportedLink[] = []
  const forest = new UnionFind()
  for (const node of nodes) forest.find(node.id)

  for (const pending of pendingEdges) {
    const target = nodeByNumericId.get(pending.targetNumericId)
    const source = nodeByNumericId.get(pending.sourceRefLocalId)
    if (!target || !source) {
      warnings.push(`POU "${pouName}": LD connection references unknown localId "${pending.sourceRefLocalId}", skipped`)
      continue
    }
    const sourceHandle = pending.sourceFormalParameter ?? LEAF_OUTPUT_HANDLE
    const edge: Edge = {
      id: `xy-edge__${source.id}${sourceHandle}-${target.id}${pending.targetHandle}`,
      source: source.id,
      sourceHandle,
      target: target.id,
      targetHandle: pending.targetHandle,
      type: 'smoothstep',
    }
    links.push({ edge, source, target })
    forest.union(source.id, target.id)
  }

  // Rungs aren't wrapped by any XML element in this dialect — all rungs
  // flatten into one shared <LD> (see ladderToXml) and are only
  // reconstructable by tracing which nodes are connected to each other.
  // Rungs never cross-connect, so a connected-component partition of the
  // node/edge graph recovers them, without needing the array-position
  // pairing the generator's own output happens to preserve.
  const allComponents: string[] = []
  const componentNodes = new Map<string, LadderParsedNode[]>()
  for (const node of nodes) {
    const root = forest.find(node.id)
    const group = componentNodes.get(root)
    if (group) {
      group.push(node)
    } else {
      componentNodes.set(root, [node])
      allComponents.push(root)
    }
  }

  // A component of nothing but power rails is one of two things. A left and a
  // right rail wired to each other is an empty rung — what `startLadderRung`
  // creates, and what the user sees after adding a rung and not yet filling it
  // in; dropping it loses the rung on every reload. A rail on its own is one
  // the file left unwired (CODESYS emits its <rightPowerRail> with an empty
  // <connectionPointIn>, so it lands in a component of its own), which would
  // import as a rung the editor cannot lay out or add to.
  //
  // The forest is unioned only across edges, so a rail-only component holding
  // more than one node is necessarily a wired pair.
  const componentOrder: string[] = []
  let skippedEmptyNetworks = 0
  for (const root of allComponents) {
    const group = componentNodes.get(root) ?? []
    if (group.some((node) => node.type !== 'powerRail') || group.length > 1) componentOrder.push(root)
    else skippedEmptyNetworks += 1
  }
  if (skippedEmptyNetworks > 0) {
    warnings.push(
      `POU "${pouName}": ${skippedEmptyNetworks} LD network(s) with no elements (unwired power rail) skipped`,
    )
  }

  // A variable box wired to nothing has nowhere to be drawn: it is not a rung of its own.
  const rungRoots = componentOrder.filter((root) => !(componentNodes.get(root) ?? []).every(isVariable))
  const strayVariables = componentOrder.length - rungRoots.length
  if (strayVariables > 0) {
    warnings.push(`POU "${pouName}": ${strayVariables} unconnected LD variable box(es) skipped`)
  }

  // Rung stacking bakes a cumulative Y shift into every node's position (the
  // generator adds each preceding rung's viewport height, see ladderToXml). A
  // rebuilt rung is laid out afresh, but a rung that falls back to the XML's
  // layout would otherwise sit far below its own viewport — a large blank gap
  // above the elements, growing with every rung. Re-base each such rung so its
  // topmost element sits where the first rung's does.
  const rungTops = rungRoots.map((root) => {
    const rungNodes = componentNodes.get(root) ?? []
    return rungNodes.length > 0 ? Math.min(...rungNodes.map((n) => n.position.y)) : 0
  })
  const topmostRungY = rungTops.length > 0 ? Math.min(...rungTops) : 0

  const rungs: LadderFlowType['rungs'] = rungRoots.map((root, index) => {
    const rungNodes = componentNodes.get(root) ?? []
    const rungNodeIds = new Set(rungNodes.map((n) => n.id))
    const rungLinks = links.filter((link) => rungNodeIds.has(link.source.id))
    const rungEdges = rungLinks.map((link) => link.edge)

    const rebuilt = rebuildRung(
      pouName,
      `rung_${pouName}_${newUuid()}`,
      { nodes: rungNodes, links: rungLinks },
      context,
      warnings,
    )
    if (rebuilt.ok) return rebuilt.rung
    warnings.push(`POU "${pouName}": rung ${index + 1} kept the layout from the XML, because ${rebuilt.reason}`)

    // Electrical order, as the editor reads the array as the rung's serial spine (see orderRungNodes), and
    // re-based vertically so the rung does not open with the XML's cumulative offset above it.
    const orderedNodes = orderRungNodes(rungNodes, rungEdges)
    translateRungY(orderedNodes, topmostRungY - rungTops[index])

    // Without the resolved signature its blocks would transpile with no inputs.
    const fallbackNodes = orderedNodes.map((node) => withResolvedSignature(pouName, node, context, warnings))

    const minX = Math.min(...orderedNodes.map((n) => n.position.x))
    const minY = Math.min(...orderedNodes.map((n) => n.position.y))
    const maxX = Math.max(...orderedNodes.map((n) => n.position.x + (n.width ?? 0)))
    const maxY = Math.max(...orderedNodes.map((n) => n.position.y + (n.height ?? 0)))

    return {
      id: `rung-${index}`,
      comment: '',
      defaultBounds: [minX, minY, maxX, maxY],
      reactFlowViewport: [maxX - minX, maxY - minY],
      selectedNodes: [],
      nodes: fallbackNodes,
      edges: rungEdges,
    }
  })

  return { body: { name: pouName, updated: false, rungs }, warnings }
}
