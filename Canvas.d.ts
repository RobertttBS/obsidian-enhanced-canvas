import { ItemView, TFile } from "obsidian"
import type { CanvasData, CanvasEdgeData, CanvasNodeData } from "obsidian/canvas"

export type { AllCanvasNodeData, CanvasData, CanvasEdgeData, CanvasNodeData } from "obsidian/canvas"

declare module "obsidian" {
  interface MetadataCache {
    getBacklinksForFile(file: TFile): { data: Map<string, unknown[]> }
    getTags(): Record<string, number>
  }
}

export interface Size {
  width: number
  height: number
}

export interface Position {
  x: number
  y: number
}

/** Reverse-engineered Canvas internals — only the members this plugin uses. */
export interface Canvas {
  view: CanvasView
  config: CanvasConfig

  getData(): CanvasData
  setData(data: CanvasData): void

  nodes: Map<string, CanvasNode>

  readonly: boolean

  selection: Set<CanvasNode>
  deselectAll(): void
  select(node: CanvasNode): void
  zoomToSelection(): void

  createFileNode(options: { [key: string]: unknown }): CanvasNode

  // Patched by this plugin (registerCanvasAutoLink / drag-temp-node).
  addNode(node: CanvasNode): void
  removeNode(node: CanvasNode): void
  addEdge(edge: CanvasEdge): void
  removeEdge(edge: CanvasEdge): void
  dragTempNode(dragEvent: unknown, nodeSize: Size, onDropped: (position: Position) => void): void

  requestSave(save?: boolean): void

  // Custom flag set by the clear() patch so node/edge removal hooks can skip
  // cleanup during a full canvas clear.
  isClearing?: boolean
}

export interface CanvasConfig {
  defaultTextNodeDimensions: Size
  defaultFileNodeDimensions: Size
}

export interface CanvasView extends ItemView {
  file: TFile
  canvas: Canvas
}

export interface CanvasNode {
  id: string
  canvas: Canvas

  nodeEl: HTMLElement

  file?: TFile
  /** Path string for file-backed nodes; mirrors CanvasNodeData.file. */
  filePath?: string
  /** Body text for text nodes; undefined for non-text nodes. */
  text?: string

  x: number
  y: number
  width: number
  height: number
}

export interface CanvasEdge {
  canvas: Canvas

  from: {
    node: CanvasNode
  }
  to: {
    node: CanvasNode
  }
}
