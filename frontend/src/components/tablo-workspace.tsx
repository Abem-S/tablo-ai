"use client";

import { useEffect, useRef, useState } from "react";
import { Tldraw, type Editor, type TLShapeId } from "tldraw";
import { toRichText } from "@tldraw/tlschema";
import { LiveKitRoom, RoomAudioRenderer, VoiceAssistantControlBar, useRoomContext } from "@livekit/components-react";
import { LocalVideoTrack, Track } from "livekit-client";
import "@livekit/components-styles";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

type SessionBootstrap = {
  session_id: string;
  transport_status: string;
  board_status: string;
  backend_status: string;
  capabilities: string[];
  checked_at: string;
};

type BoardMetrics = {
  summary: string;
  shapeCount: number;
  selectedCount: number;
};

type RealtimeConfig = {
  configured: boolean;
  livekit_url: string | null;
  backend_conversion_boundary: string;
  livekit_audio_hz: number;
  gemini_input_hz: number;
  gemini_output_hz: number;
  notes: string[];
};

type LiveKitTokenResponse = {
  server_url: string;
  room_name: string;
  participant_identity: string;
  token: string;
};

type BoardTargetRef =
  | { kind: "selection"; index?: number }
  | { kind: "pointer" }
  | { kind: "this" }
  | { kind: "that" }
  | { kind: "shape_id"; shapeId: string };

type Shape3DLabels = {
  edges?: string[];
  faces?: string[];
};

// Side Label Types (Req 6.1, 6.2, 6.3)
type LabelSide = "normal" | "inverted" | "side-inverted";
type LabelPosition = "top" | "bottom" | "left" | "right";

// Formula Types (Req 9.3, 9.4, 9.5, 9.6)
interface FormulaOptions {
  fontSize?: number;
  color?: string;
}

// Shape Matching Criteria (Req 5.2)
interface ShapeMatchCriteria {
  type?: string;
  color?: string;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  label?: string;
  containsText?: string;
}

// ============================================
// Error Types (Req 11.3, 11.4)
// ============================================

type ErrorCode =
  | "INVALID_COMMAND"
  | "VALIDATION_FAILED"
  | "SHAPE_NOT_FOUND"
  | "COLLISION_DETECTED"
  | "POSITION_OUT_OF_BOUNDS"
  | "AMBIGUOUS_REFERENCE"
  | "RENDER_FAILED";

interface CommandError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

interface CommandResult {
  success: boolean;
  commandId: string;
  error?: CommandError;
  shapeIds?: string[];
}

// ============================================
// Command Validation (Req 11.3)
// ============================================

/**
 * Validate a board command before execution
 * Returns validation result with error details if invalid
 */
function validateCommand(cmd: BoardCommand): { valid: boolean; error?: CommandError } {
  switch (cmd.op) {
    case "create_text":
    case "create_formula":
    case "create_multiline_text": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid coordinates: x and y must be finite numbers",
            details: { x: cmd.x, y: cmd.y }
          } 
        };
      }
      break;
    }
      
    case "create_geo": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || 
          !Number.isFinite(cmd.w) || !Number.isFinite(cmd.h)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid geometry parameters: x, y, w, h must be finite numbers",
            details: { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }
          } 
        };
      }
      if (cmd.w <= 0 || cmd.h <= 0) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Dimensions must be positive: w and h must be greater than 0",
            details: { w: cmd.w, h: cmd.h }
          } 
        };
      }
      break;
    }
      
    case "create_arrow": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) ||
          !Number.isFinite(cmd.toX) || !Number.isFinite(cmd.toY)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid arrow coordinates: all coordinates must be finite numbers",
            details: { x: cmd.x, y: cmd.y, toX: cmd.toX, toY: cmd.toY }
          } 
        };
      }
      break;
    }
      
    case "create_freehand":
    case "create_freehand_stroke": {
      if (!cmd.points || !Array.isArray(cmd.points) || cmd.points.length < 2) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Freehand requires at least 2 points",
            details: { pointsCount: cmd.points?.length ?? 0 }
          } 
        };
      }
      // Validate each point has valid x, y
      for (let i = 0; i < cmd.points.length; i++) {
        const p = cmd.points[i];
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          return { 
            valid: false, 
            error: { 
              code: "VALIDATION_FAILED", 
              message: `Invalid point at index ${i}: x and y must be finite numbers`,
              details: { index: i, point: p }
            } 
          };
        }
      }
      break;
    }
      
    case "clear_shapes": {
      if (!cmd.shapeIds || !Array.isArray(cmd.shapeIds)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "shapeIds must be an array",
            details: { shapeIds: cmd.shapeIds }
          } 
        };
      }
      break;
    }
      
    case "clear_region": {
      if (!cmd.bounds || 
          !Number.isFinite(cmd.bounds.x) || !Number.isFinite(cmd.bounds.y) ||
          !Number.isFinite(cmd.bounds.w) || !Number.isFinite(cmd.bounds.h)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid region bounds: x, y, w, h must be finite numbers",
            details: { bounds: cmd.bounds }
          } 
        };
      }
      if (cmd.bounds.w <= 0 || cmd.bounds.h <= 0) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Region dimensions must be positive: w and h must be greater than 0",
            details: { bounds: cmd.bounds }
          } 
        };
      }
      break;
    }
      
    case "create_3d_cube": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || !Number.isFinite(cmd.size)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid cube parameters: x, y, size must be finite numbers",
            details: { x: cmd.x, y: cmd.y, size: cmd.size }
          } 
        };
      }
      if (cmd.size <= 0) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Cube size must be positive",
            details: { size: cmd.size }
          } 
        };
      }
      break;
    }
      
    case "create_3d_prism": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || 
          !Number.isFinite(cmd.width) || !Number.isFinite(cmd.height) || !Number.isFinite(cmd.depth)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid prism parameters: all dimensions must be finite numbers",
            details: { x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height, depth: cmd.depth }
          } 
        };
      }
      if (cmd.width <= 0 || cmd.height <= 0 || cmd.depth <= 0) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Prism dimensions must be positive",
            details: { width: cmd.width, height: cmd.height, depth: cmd.depth }
          } 
        };
      }
      break;
    }
      
    case "create_3d_cylinder":
    case "create_3d_cone": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || 
          !Number.isFinite(cmd.radius) || !Number.isFinite(cmd.height)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid parameters: x, y, radius, height must be finite numbers",
            details: { x: cmd.x, y: cmd.y, radius: cmd.radius, height: cmd.height }
          } 
        };
      }
      if (cmd.radius <= 0 || cmd.height <= 0) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Radius and height must be positive",
            details: { radius: cmd.radius, height: cmd.height }
          } 
        };
      }
      break;
    }
      
    case "create_3d_pyramid": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || 
          !Number.isFinite(cmd.baseSize) || !Number.isFinite(cmd.height)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid pyramid parameters: all parameters must be finite numbers",
            details: { x: cmd.x, y: cmd.y, baseSize: cmd.baseSize, height: cmd.height }
          } 
        };
      }
      if (cmd.baseSize <= 0 || cmd.height <= 0) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Base size and height must be positive",
            details: { baseSize: cmd.baseSize, height: cmd.height }
          } 
        };
      }
      break;
    }
      
    case "get_shape_info": {
      if (!cmd.shapeId || typeof cmd.shapeId !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "shapeId must be a non-empty string",
            details: { shapeId: cmd.shapeId }
          } 
        };
      }
      break;
    }
      
    case "match_shapes": {
      if (!cmd.criteria || typeof cmd.criteria !== "object") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "criteria must be a non-empty object",
            details: { criteria: cmd.criteria }
          } 
        };
      }
      break;
    }
      
    case "place_with_collision_check": {
      if (!cmd.shape || !cmd.shape.op) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "shape must be a valid command object",
            details: { shape: cmd.shape }
          } 
        };
      }
      // Recursively validate the inner shape
      return validateCommand(cmd.shape);
    }
      
    case "calculate_position": {
      if (!cmd.sourceShapeId || typeof cmd.sourceShapeId !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "sourceShapeId must be a non-empty string",
            details: { sourceShapeId: cmd.sourceShapeId }
          } 
        };
      }
      if (!cmd.relativeTo || typeof cmd.relativeTo !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "relativeTo must be a non-empty string",
            details: { relativeTo: cmd.relativeTo }
          } 
        };
      }
      break;
    }
      
    case "get_distance": {
      if (!cmd.shapeIdA || typeof cmd.shapeIdA !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "shapeIdA must be a non-empty string",
            details: { shapeIdA: cmd.shapeIdA }
          } 
        };
      }
      if (!cmd.shapeIdB || typeof cmd.shapeIdB !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "shapeIdB must be a non-empty string",
            details: { shapeIdB: cmd.shapeIdB }
          } 
        };
      }
      break;
    }
      
    case "create_side_label": {
      if (!cmd.targetShapeId || typeof cmd.targetShapeId !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "targetShapeId must be a non-empty string",
            details: { targetShapeId: cmd.targetShapeId }
          } 
        };
      }
      if (!cmd.text || typeof cmd.text !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "text must be a non-empty string",
            details: { text: cmd.text }
          } 
        };
      }
      break;
    }
      
    case "create_text_on_target": {
      if (!cmd.text || typeof cmd.text !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "text must be a non-empty string",
            details: { text: cmd.text }
          } 
        };
      }
      if (!cmd.target || !cmd.target.kind) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "target must be a valid BoardTargetRef object",
            details: { target: cmd.target }
          } 
        };
      }
      break;
    }
      
    case "create_arrow_between_targets": {
      if (!cmd.from || !cmd.from.kind) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "from must be a valid BoardTargetRef object",
            details: { from: cmd.from }
          } 
        };
      }
      if (!cmd.to || !cmd.to.kind) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "to must be a valid BoardTargetRef object",
            details: { to: cmd.to }
          } 
        };
      }
      break;
    }
      
    case "create_text_near_selection": {
      if (!cmd.text || typeof cmd.text !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "text must be a non-empty string",
            details: { text: cmd.text }
          } 
        };
      }
      break;
    }
      
    // Grid Snap Commands (Req 12.3)
    case "snap_to_grid": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid coordinates: x and y must be finite numbers",
            details: { x: cmd.x, y: cmd.y }
          } 
        };
      }
      if (cmd.gridSize !== undefined && (!Number.isFinite(cmd.gridSize) || cmd.gridSize <= 0)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "gridSize must be a positive number",
            details: { gridSize: cmd.gridSize }
          } 
        };
      }
      break;
    }
      
    case "snap_bounds_to_grid": {
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || 
          !Number.isFinite(cmd.w) || !Number.isFinite(cmd.h)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Invalid bounds: x, y, w, h must be finite numbers",
            details: { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }
          } 
        };
      }
      if (cmd.w <= 0 || cmd.h <= 0) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "Dimensions must be positive: w and h must be greater than 0",
            details: { w: cmd.w, h: cmd.h }
          } 
        };
      }
      if (cmd.gridSize !== undefined && (!Number.isFinite(cmd.gridSize) || cmd.gridSize <= 0)) {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "gridSize must be a positive number",
            details: { gridSize: cmd.gridSize }
          } 
        };
      }
      break;
    }
      
    // Alignment Commands (Req 12.4)
    case "align_shapes": {
      if (!cmd.sourceShapeId || typeof cmd.sourceShapeId !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "sourceShapeId must be a non-empty string",
            details: { sourceShapeId: cmd.sourceShapeId }
          } 
        };
      }
      if (!cmd.targetShapeId || typeof cmd.targetShapeId !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "targetShapeId must be a non-empty string",
            details: { targetShapeId: cmd.targetShapeId }
          } 
        };
      }
      if (!cmd.sourcePoint || typeof cmd.sourcePoint !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "sourcePoint must be a valid AlignmentPoint",
            details: { sourcePoint: cmd.sourcePoint }
          } 
        };
      }
      if (!cmd.targetPoint || typeof cmd.targetPoint !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "targetPoint must be a valid AlignmentPoint",
            details: { targetPoint: cmd.targetPoint }
          } 
        };
      }
      break;
    }
  }
  
  return { valid: true };
}

/**
 * Log a command execution result (Req 11.5)
 */
function logCommand(cmd: BoardCommand, result: CommandResult): void {
  const timestamp = new Date().toISOString();
  const status = result.success ? "SUCCESS" : "FAILED";
  const commandId = cmd.id || "unknown";
  
  if (result.success) {
    console.log(`[${timestamp}] ${cmd.op} (${commandId}): ${status}`, 
      result.shapeIds ? `Created ${result.shapeIds.length} shape(s)` : "");
  } else {
    console.error(`[${timestamp}] ${cmd.op} (${commandId}): ${status}`, 
      result.error ? `${result.error.code}: ${result.error.message}` : "",
      result.error?.details ? result.error.details : "");
  }
}

type BoardCommand =
  | {
      v: number;
      id: string;
      op: "create_text";
      text: string;
      x: number;
      y: number;
      fontSize?: number;
      color?: string;
    }
  | {
      v: number;
      id: string;
      op: "create_multiline_text";
      lines: string[];
      x: number;
      y: number;
      fontSize?: number;
      color?: string;
      alignment?: "left" | "center" | "right";
      lineSpacing?: number;
    }
  | {
      v: number;
      id: string;
      op: "create_text_near_selection";
      text: string;
      offsetX?: number;
      offsetY?: number;
    }
  // Text & Formula Commands (Req 9.1, 9.2, 9.3, 9.4, 9.5, 9.6)
  | {
      v: number;
      id: string;
      op: "create_formula";
      formula: string;
      x: number;
      y: number;
      fontSize?: number;
      color?: string;
    }
  | {
      v: number;
      id: string;
      op: "create_geo";
      geo: "rectangle" | "ellipse" | "diamond" | "triangle";
      x: number;
      y: number;
      w: number;
      h: number;
      label?: string;
    }
  | {
      v: number;
      id: string;
      op: "create_arrow";
      x: number;
      y: number;
      toX: number;
      toY: number;
    }
  | {
      v: number;
      id: string;
      op: "create_text_on_target";
      text: string;
      target: BoardTargetRef;
      placement?: "center" | "top" | "bottom" | "left" | "right";
      offset?: number;
    }
  | {
      v: number;
      id: string;
      op: "create_arrow_between_targets";
      from: BoardTargetRef;
      to: BoardTargetRef;
      label?: string;
    }
  | {
      v: number;
      id: string;
      op: "create_freehand";
      points: Point[];
      strokeWidth?: number;
      color?: string;
    }
  | {
      v: number;
      id: string;
      op: "create_freehand_stroke";
      points: Point[];
      strokeWidth: number;
      color: string;
    }
  | {
      v: number;
      id: string;
      op: "clear_board";
    }
  | {
      v: number;
      id: string;
      op: "clear_shapes";
      shapeIds: string[];
    }
  | {
      v: number;
      id: string;
      op: "clear_region";
      bounds: { x: number; y: number; w: number; h: number };
    }
  // 3D Shape Commands
  | {
      v: number;
      id: string;
      op: "create_3d_cube";
      x: number;
      y: number;
      size: number;
      labels?: Shape3DLabels;
    }
  | {
      v: number;
      id: string;
      op: "create_3d_prism";
      x: number;
      y: number;
      width: number;
      height: number;
      depth: number;
      type?: "rectangular" | "triangular";
      labels?: Shape3DLabels;
    }
  | {
      v: number;
      id: string;
      op: "create_3d_cylinder";
      x: number;
      y: number;
      radius: number;
      height: number;
      labels?: Shape3DLabels;
    }
  | {
      v: number;
      id: string;
      op: "create_3d_cone";
      x: number;
      y: number;
      radius: number;
      height: number;
      labels?: Shape3DLabels;
    }
  | {
      v: number;
      id: string;
      op: "create_3d_pyramid";
      x: number;
      y: number;
      baseSize: number;
      height: number;
      labels?: Shape3DLabels;
    }
  // Board State Commands (Req 3.1, 3.2)
  | {
      v: number;
      id: string;
      op: "get_board_state";
    }
  | {
      v: number;
      id: string;
      op: "get_shape_info";
      shapeId: string;
    }
  // Shape Matching Command (Req 5.2)
  | {
      v: number;
      id: string;
      op: "match_shapes";
      criteria: ShapeMatchCriteria;
      limit?: number;
    }
  // Collision Detection Commands (Req 4.1, 4.2, 4.3, 4.4, 4.5)
  | {
      v: number;
      id: string;
      op: "place_with_collision_check";
      shape: BoardCommand;
      avoidShapeIds?: string[];
      allowOverlap?: boolean;
    }
  // Position Intelligence Commands (Req 10.1-10.6)
  | {
      v: number;
      id: string;
      op: "get_position_info";
      query: "bounds" | "quadrants" | "center_of_mass" | "empty_regions" | "all";
    }
  | {
      v: number;
      id: string;
      op: "calculate_position";
      sourceShapeId: string;
      relativeTo: RelativePosition;
      offset?: number;
    }
  | {
      v: number;
      id: string;
      op: "get_distance";
      shapeIdA: string;
      shapeIdB: string;
    }
  | {
      v: number;
      id: string;
      op: "suggest_placement";
      preferredRegion?: string;
    }
  // Side Label Commands (Req 6.1, 6.2, 6.3, 6.4, 6.5)
  | {
      v: number;
      id: string;
      op: "create_side_label";
      targetShapeId: string;
      text: string;
      side: LabelSide;
      position?: LabelPosition;
      offset?: number;
    }
  // Grid Snap Commands (Req 12.3)
  | {
      v: number;
      id: string;
      op: "snap_to_grid";
      x: number;
      y: number;
      gridSize?: number;
    }
  | {
      v: number;
      id: string;
      op: "snap_bounds_to_grid";
      x: number;
      y: number;
      w: number;
      h: number;
      gridSize?: number;
    }
  // Alignment Commands (Req 12.4)
  | {
      v: number;
      id: string;
      op: "align_shapes";
      sourceShapeId: string;
      targetShapeId: string;
      sourcePoint: AlignmentPoint;
      targetPoint: AlignmentPoint;
    };

type Point = { x: number; y: number };

// ============================================
// Board State Types (Req 3.1, 3.2, 3.3, 5.3)
// ============================================

type ShapeType = "draw" | "geo" | "text" | "arrow" | "group" | "note" | "line" | "frame" | "image";

interface ShapeInfo {
  id: string;
  type: ShapeType;
  bounds: PageRect;
  center: { x: number; y: number };
  color?: string;
  label?: string;
  createdAt: number;
  zIndex: number;
}

interface ShapeRelationship {
  shapeIdA: string;
  shapeIdB: string;
  type: "adjacent" | "contains" | "overlaps" | "proximity";
  distance?: number;
}

interface FocusEntry {
  shapeId: string;
  timestamp: number;
  reference: "this" | "that";
}

interface BoardState {
  shapes: Map<string, ShapeInfo>;
  relationships: ShapeRelationship[];
  focusHistory: FocusEntry[];
}

// ============================================
// Board State Manager (Req 3.1, 3.2, 3.3, 5.3)
// ============================================

/**
 * Create an empty board state
 */
function createBoardState(): BoardState {
  return {
    shapes: new Map(),
    relationships: [],
    focusHistory: [],
  };
}

/**
 * Get the shape type from tldraw shape
 */
function getShapeType(shape: any): ShapeType {
  const typeMap: Record<string, ShapeType> = {
    draw: "draw",
    geo: "geo",
    text: "text",
    arrow: "arrow",
    group: "group",
    note: "note",
    line: "line",
    frame: "frame",
    image: "image",
  };
  return typeMap[shape.type] ?? "geo";
}

/**
 * Get color from shape props
 */
function getShapeColor(shape: any): string | undefined {
  if (!shape.props) return undefined;
  const color = shape.props.color as string | undefined;
  return color;
}

/**
 * Get label from shape props (richText or text)
 */
function getShapeLabel(shape: any): string | undefined {
  if (!shape.props) return undefined;
  const richText = shape.props.richText as string | undefined;
  const text = shape.props.text as string | undefined;
  return richText ?? text;
}

/**
 * Update board state from editor
 */
function updateBoardState(editor: Editor, state: BoardState): void {
  const shapes = editor.getCurrentPageShapes();
  const shapeIds = editor.getCurrentPageShapeIds();
  
  // Get z-index ordering
  const pageSorted = editor.getPageShapeIds(editor.getCurrentPageId());
  const zIndexMap = new Map<string, number>();
  const pageSortedArray = Array.from(pageSorted);
  for (let index = 0; index < pageSortedArray.length; index++) {
    const id = pageSortedArray[index];
    zIndexMap.set(String(id), index);
  }

  // Clear existing shapes and rebuild
  state.shapes.clear();

  for (const shape of shapes) {
    const bounds = editor.getShapePageBounds(shape);
    if (!bounds) continue;

    const shapeIdStr = String(shape.id);
    const shapeInfo: ShapeInfo = {
      id: shapeIdStr,
      type: getShapeType(shape),
      bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
      center: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
      color: getShapeColor(shape),
      label: getShapeLabel(shape),
      createdAt: Date.now(),
      zIndex: zIndexMap.get(shapeIdStr) ?? 0,
    };

    state.shapes.set(shapeIdStr, shapeInfo);
  }

  // Recalculate relationships
  state.relationships = detectRelationships(state.shapes);
}

/**
 * Detect relationships between shapes
 */
function detectRelationships(shapes: Map<string, ShapeInfo>): ShapeRelationship[] {
  const relationships: ShapeRelationship[] = [];
  const shapeArray = Array.from(shapes.values());
  const proximityThreshold = 50;

  for (let i = 0; i < shapeArray.length; i++) {
    for (let j = i + 1; j < shapeArray.length; j++) {
      const shapeA = shapeArray[i];
      const shapeB = shapeArray[j];

      // Calculate distance between centers
      const dx = shapeA.center.x - shapeB.center.x;
      const dy = shapeA.center.y - shapeB.center.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Check for containment
      if (contains(shapeA.bounds, shapeB.bounds)) {
        relationships.push({
          shapeIdA: shapeA.id,
          shapeIdB: shapeB.id,
          type: "contains",
          distance,
        });
        continue;
      }

      if (contains(shapeB.bounds, shapeA.bounds)) {
        relationships.push({
          shapeIdA: shapeB.id,
          shapeIdB: shapeA.id,
          type: "contains",
          distance,
        });
        continue;
      }

      // Check for overlap
      if (overlaps(shapeA.bounds, shapeB.bounds)) {
        relationships.push({
          shapeIdA: shapeA.id,
          shapeIdB: shapeB.id,
          type: "overlaps",
          distance,
        });
        continue;
      }

      // Check for adjacency (touching or very close)
      if (isAdjacent(shapeA.bounds, shapeB.bounds)) {
        relationships.push({
          shapeIdA: shapeA.id,
          shapeIdB: shapeB.id,
          type: "adjacent",
          distance,
        });
        continue;
      }

      // Check for proximity
      if (distance <= proximityThreshold) {
        relationships.push({
          shapeIdA: shapeA.id,
          shapeIdB: shapeB.id,
          type: "proximity",
          distance,
        });
      }
    }
  }

  return relationships;
}

/**
 * Check if boundsA contains boundsB
 */
function contains(a: PageRect, b: PageRect): boolean {
  return (
    b.x >= a.x &&
    b.y >= a.y &&
    b.x + b.w <= a.x + a.w &&
    b.y + b.h <= a.y + a.h
  );
}

/**
 * Check if two bounds overlap
 */
function overlaps(a: PageRect, b: PageRect): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * Check if two bounds are adjacent (touching or very close)
 */
function isAdjacent(a: PageRect, b: PageRect, threshold = 5): boolean {
  const expandedA = {
    x: a.x - threshold,
    y: a.y - threshold,
    w: a.w + threshold * 2,
    h: a.h + threshold * 2,
  };
  return overlaps(expandedA, b) && !overlaps(a, b);
}

/**
 * Calculate distance between two points
 */
function calculateDistance(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Update focus history with a new shape reference
 */
function updateBoardFocusHistory(state: BoardState, shapeId: string, reference: "this" | "that"): void {
  const entry: FocusEntry = {
    shapeId,
    timestamp: Date.now(),
    reference,
  };

  // Add to history
  state.focusHistory.push(entry);

  // Keep only last 20 entries
  if (state.focusHistory.length > 20) {
    state.focusHistory = state.focusHistory.slice(-20);
  }
}

/**
 * Get board state summary for AI agent
 */
function getBoardStateSummary(state: BoardState): {
  shapeCount: number;
  shapes: ShapeInfo[];
  relationships: ShapeRelationship[];
  focusHistory: FocusEntry[];
  thisShape: ShapeInfo | null;
  thatShape: ShapeInfo | null;
} {
  const shapes = Array.from(state.shapes.values()).sort((a, b) => a.zIndex - b.zIndex);
  
  // Get "this" and "that" shapes from focus history
  let thisShape: ShapeInfo | null = null;
  let thatShape: ShapeInfo | null = null;

  for (let i = state.focusHistory.length - 1; i >= 0; i--) {
    const entry = state.focusHistory[i];
    if (entry.reference === "this" && !thisShape) {
      thisShape = state.shapes.get(entry.shapeId) ?? null;
    }
    if (entry.reference === "that" && !thatShape) {
      thatShape = state.shapes.get(entry.shapeId) ?? null;
    }
    if (thisShape && thatShape) break;
  }

  return {
    shapeCount: state.shapes.size,
    shapes,
    relationships: state.relationships,
    focusHistory: state.focusHistory,
    thisShape,
    thatShape,
  };
}

/**
 * Get detailed info for a specific shape
 */
function getShapeInfoById(state: BoardState, shapeId: string): ShapeInfo | null {
  return state.shapes.get(shapeId) ?? null;
}

// ============================================
// Shape Matching by Visual Properties (Req 5.2)
// ============================================

interface ShapeMatchResult {
  shapeId: string;
  confidence: number;
}

/**
 * Normalize color for comparison (handles hex, named colors, etc.)
 */
function normalizeColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  
  // Convert to lowercase for comparison
  const normalized = color.toLowerCase().trim();
  
  // Handle hex colors
  if (normalized.startsWith('#')) {
    return normalized;
  }
  
  // Map common named colors to hex
  const colorMap: Record<string, string> = {
    'black': '#000000',
    'white': '#ffffff',
    'red': '#ff0000',
    'green': '#00ff00',
    'blue': '#0000ff',
    'yellow': '#ffff00',
    'orange': '#ffa500',
    'purple': '#800080',
    'pink': '#ffc0cb',
    'gray': '#808080',
    'grey': '#808080',
  };
  
  return colorMap[normalized] ?? normalized;
}

/**
 * Check if a color matches the criteria
 */
function colorMatches(shapeColor: string | undefined, criteriaColor: string): boolean {
  if (!shapeColor) return false;
  
  const normalizedShapeColor = normalizeColor(shapeColor);
  const normalizedCriteriaColor = normalizeColor(criteriaColor);
  
  if (!normalizedShapeColor || !normalizedCriteriaColor) return false;
  
  // Exact match
  if (normalizedShapeColor === normalizedCriteriaColor) return true;
  
  // Check if criteria color is contained in shape color (for partial matches)
  return normalizedShapeColor.includes(normalizedCriteriaColor) || 
         normalizedCriteriaColor.includes(normalizedShapeColor);
}

/**
 * Calculate confidence score for a shape matching criteria
 */
function calculateMatchConfidence(
  shape: ShapeInfo,
  criteria: ShapeMatchCriteria
): number {
  let score = 0;
  let maxScore = 0;
  
  // Type matching (max 1.0)
  if (criteria.type) {
    maxScore += 1.0;
    if (shape.type.toLowerCase() === criteria.type.toLowerCase()) {
      score += 1.0;
    } else if (shape.type.toLowerCase().includes(criteria.type.toLowerCase())) {
      score += 0.7;
    }
  }
  
  // Color matching (max 1.0)
  if (criteria.color) {
    maxScore += 1.0;
    if (colorMatches(shape.color, criteria.color)) {
      score += 1.0;
    }
  }
  
  // Width range matching (max 1.0)
  if (criteria.minWidth !== undefined || criteria.maxWidth !== undefined) {
    maxScore += 1.0;
    const width = shape.bounds.w;
    const minW = criteria.minWidth ?? 0;
    const maxW = criteria.maxWidth ?? Infinity;
    
    if (width >= minW && width <= maxW) {
      // Exact match within range
      score += 1.0;
    } else if (width >= minW * 0.8 && width <= maxW * 1.2) {
      // Close to range
      score += 0.5;
    }
  }
  
  // Height range matching (max 1.0)
  if (criteria.minHeight !== undefined || criteria.maxHeight !== undefined) {
    maxScore += 1.0;
    const height = shape.bounds.h;
    const minH = criteria.minHeight ?? 0;
    const maxH = criteria.maxHeight ?? Infinity;
    
    if (height >= minH && height <= maxH) {
      score += 1.0;
    } else if (height >= minH * 0.8 && height <= maxH * 1.2) {
      score += 0.5;
    }
  }
  
  // Label matching (max 1.0)
  if (criteria.label) {
    maxScore += 1.0;
    if (shape.label) {
      const shapeLabelLower = shape.label.toLowerCase();
      const criteriaLabelLower = criteria.label.toLowerCase();
      
      if (shapeLabelLower === criteriaLabelLower) {
        score += 1.0;
      } else if (shapeLabelLower.includes(criteriaLabelLower)) {
        score += 0.8;
      }
    }
  }
  
  // Contains text matching (max 1.0)
  if (criteria.containsText) {
    maxScore += 1.0;
    if (shape.label) {
      if (shape.label.toLowerCase().includes(criteria.containsText.toLowerCase())) {
        score += 1.0;
      }
    }
  }
  
  // If no criteria specified, return 0 (no match)
  if (maxScore === 0) return 0;
  
  return score / maxScore;
}

/**
 * Find shapes matching the given criteria
 * Returns results sorted by confidence score (highest first)
 */
function findShapesByProperties(
  editor: Editor,
  criteria: ShapeMatchCriteria,
  boardState: BoardState
): ShapeMatchResult[] {
  const results: ShapeMatchResult[] = [];
  
  // If no criteria provided, return empty results
  if (!criteria || Object.keys(criteria).length === 0) {
    return results;
  }
  
  // Iterate through all shapes in board state
  for (const [shapeId, shape] of boardState.shapes) {
    // Verify shape still exists in editor
    if (!editor.getShape(shapeId as any)) continue;
    
    const confidence = calculateMatchConfidence(shape, criteria);
    
    // Only include shapes with non-zero confidence
    if (confidence > 0) {
      results.push({
        shapeId,
        confidence,
      });
    }
  }
  
  // Sort by confidence (highest first)
  results.sort((a, b) => b.confidence - a.confidence);
  
  return results;
}

// ============================================
// Collision Detection Module (Req 4.1, 4.2, 4.3, 4.4, 4.5)
// ============================================

/**
 * Check if two rectangles overlap
 */
function doRectsOverlap(a: PageRect, b: PageRect): boolean {
  return !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  );
}

/**
 * Find all shapes that overlap with the given bounds
 */
function findCollidingShapes(
  editor: Editor,
  bounds: PageRect,
  excludeIds?: string[]
): string[] {
  const shapes = editor.getCurrentPageShapes();
  const colliding: string[] = [];

  for (const shape of shapes) {
    if (excludeIds?.includes(shape.id)) continue;
    const shapeBounds = editor.getShapePageBounds(shape);
    if (
      shapeBounds &&
      doRectsOverlap(bounds, {
        x: shapeBounds.x,
        y: shapeBounds.y,
        w: shapeBounds.w,
        h: shapeBounds.h,
      })
    ) {
      colliding.push(shape.id);
    }
  }
  return colliding;
}

/**
 * Calculate alternative position that doesn't collide
 */
function findAlternativePosition(
  editor: Editor,
  proposedBounds: PageRect,
  direction: "right" | "down" | "left" | "up" = "right",
  minDistance: number = 20
): { x: number; y: number } {
  // Try shifting in the given direction
  let offset = minDistance;
  const maxAttempts = 10;

  for (let i = 0; i < maxAttempts; i++) {
    const newBounds = { ...proposedBounds };
    switch (direction) {
      case "right":
        newBounds.x += offset;
        break;
      case "left":
        newBounds.x -= offset;
        break;
      case "down":
        newBounds.y += offset;
        break;
      case "up":
        newBounds.y -= offset;
        break;
    }

    const colliding = findCollidingShapes(editor, newBounds);
    if (colliding.length === 0) {
      return { x: newBounds.x, y: newBounds.y };
    }
    offset += minDistance;
  }

  // Fallback: return original position
  return { x: proposedBounds.x, y: proposedBounds.y };
}

/**
 * Extract bounds from a shape command
 */
function getBoundsFromCommand(cmd: BoardCommand): PageRect | null {
  switch (cmd.op) {
    case "create_geo": {
      const c = cmd as typeof cmd & { op: "create_geo" };
      return {
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
      };
    }
    case "create_text": {
      const c = cmd as typeof cmd & { op: "create_text" };
      return {
        x: c.x,
        y: c.y,
        w: 100, // Default text width estimate
        h: 24, // Default text height estimate
      };
    }
    case "create_text_on_target":
      // Text on target doesn't have fixed bounds until resolved
      return null;
    case "create_arrow": {
      const c = cmd as typeof cmd & { op: "create_arrow" };
      // Arrow bounds depend on start and end points
      const minX = Math.min(c.x, c.toX);
      const minY = Math.min(c.y, c.toY);
      const maxX = Math.max(c.x, c.toX);
      const maxY = Math.max(c.y, c.toY);
      return {
        x: minX,
        y: minY,
        w: Math.max(maxX - minX, 1),
        h: Math.max(maxY - minY, 1),
      };
    }
    case "create_freehand":
    case "create_freehand_stroke": {
      const c = cmd as typeof cmd & { op: "create_freehand" | "create_freehand_stroke" };
      if (!c.points || c.points.length === 0) return null;
      const xs = c.points.map((p) => p.x);
      const ys = c.points.map((p) => p.y);
      const fMinX = Math.min(...xs);
      const fMinY = Math.min(...ys);
      const fMaxX = Math.max(...xs);
      const fMaxY = Math.max(...ys);
      return {
        x: fMinX,
        y: fMinY,
        w: fMaxX - fMinX,
        h: fMaxY - fMinY,
      };
    }
    case "create_3d_cube": {
      const c = cmd as typeof cmd & { op: "create_3d_cube" };
      return {
        x: c.x - c.size / 2,
        y: c.y - c.size / 2,
        w: c.size,
        h: c.size,
      };
    }
    case "create_3d_prism": {
      const c = cmd as typeof cmd & { op: "create_3d_prism" };
      return {
        x: c.x - c.width / 2,
        y: c.y - c.height / 2,
        w: c.width,
        h: c.height,
      };
    }
    case "create_3d_cylinder": {
      const c = cmd as typeof cmd & { op: "create_3d_cylinder" };
      return {
        x: c.x - c.radius,
        y: c.y - c.height,
        w: c.radius * 2,
        h: c.height,
      };
    }
    case "create_3d_cone": {
      const c = cmd as typeof cmd & { op: "create_3d_cone" };
      return {
        x: c.x - c.radius,
        y: c.y - c.height,
        w: c.radius * 2,
        h: c.height,
      };
    }
    case "create_3d_pyramid": {
      const c = cmd as typeof cmd & { op: "create_3d_pyramid" };
      return {
        x: c.x - c.baseSize / 2,
        y: c.y - c.height,
        w: c.baseSize,
        h: c.height,
      };
    }
    default:
      return null;
  }
}

/**
 * Modify a command's position to the suggested position
 */
function modifyCommandPosition(
  cmd: BoardCommand,
  newPosition: { x: number; y: number }
): BoardCommand | null {
  // Create a deep copy to avoid mutating the original
  const modified = JSON.parse(JSON.stringify(cmd)) as BoardCommand;

  switch (cmd.op) {
    case "create_geo": {
      const c = modified as typeof modified & { op: "create_geo" };
      c.x = newPosition.x;
      c.y = newPosition.y;
      return c;
    }
    case "create_text": {
      const c = modified as typeof modified & { op: "create_text" };
      c.x = newPosition.x;
      c.y = newPosition.y;
      return c;
    }
    case "create_arrow": {
      const c = modified as typeof modified & { op: "create_arrow" };
      const origCmd = cmd as typeof cmd & { op: "create_arrow" };
      // For arrows, shift both start and end points by the same offset
      const dx = newPosition.x - origCmd.x;
      const dy = newPosition.y - origCmd.y;
      c.x = newPosition.x;
      c.y = newPosition.y;
      c.toX = origCmd.toX + dx;
      c.toY = origCmd.toY + dy;
      return c;
    }
    case "create_freehand":
    case "create_freehand_stroke": {
      const c = modified as typeof modified & { op: "create_freehand" | "create_freehand_stroke" };
      const origCmd = cmd as typeof cmd & { op: "create_freehand" | "create_freehand_stroke" };
      // Shift all points
      const origBounds = getBoundsFromCommand(cmd);
      if (!origBounds) return null;
      const offsetX = newPosition.x - origBounds.x;
      const offsetY = newPosition.y - origBounds.y;
      c.points = origCmd.points.map((p) => ({
        x: p.x + offsetX,
        y: p.y + offsetY,
      }));
      return c;
    }
    case "create_3d_cube": {
      const c = modified as typeof modified & { op: "create_3d_cube" };
      c.x = newPosition.x + c.size / 2;
      c.y = newPosition.y + c.size / 2;
      return c;
    }
    case "create_3d_prism": {
      const c = modified as typeof modified & { op: "create_3d_prism" };
      c.x = newPosition.x + c.width / 2;
      c.y = newPosition.y + c.height / 2;
      return c;
    }
    case "create_3d_cylinder": {
      const c = modified as typeof modified & { op: "create_3d_cylinder" };
      c.x = newPosition.x + c.radius;
      c.y = newPosition.y + c.height;
      return c;
    }
    case "create_3d_cone": {
      const c = modified as typeof modified & { op: "create_3d_cone" };
      c.x = newPosition.x + c.radius;
      c.y = newPosition.y + c.height;
      return c;
    }
    case "create_3d_pyramid": {
      const c = modified as typeof modified & { op: "create_3d_pyramid" };
      c.x = newPosition.x + c.baseSize / 2;
      c.y = newPosition.y + c.height;
      return c;
    }
    default:
      return null;
  }
}

// ============================================
// Position Intelligence Engine (Req 10.1-10.6)
// ============================================

/**
 * Get board bounds from editor viewport (Req 10.1)
 * Returns bounds in page coordinates
 */
function getBoardBounds(editor: Editor): BoardBounds | null {
  const pageBounds = editor.getCurrentPageBounds();
  if (!pageBounds) return null;

  return {
    x: pageBounds.x,
    y: pageBounds.y,
    width: pageBounds.w,
    height: pageBounds.h,
    centerX: pageBounds.x + pageBounds.w / 2,
    centerY: pageBounds.y + pageBounds.h / 2,
  };
}

/**
 * Calculate distance between two points (Req 10.2)
 */
function calculatePointDistance(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate distance between two shapes (center to center) (Req 10.2)
 * Ensures symmetric distance calculation
 */
function calculateShapeDistance(shapeA: ShapeInfo, shapeB: ShapeInfo): number {
  return calculatePointDistance(shapeA.center, shapeB.center);
}

/**
 * Get board quadrants (Req 10.3)
 * Returns 4 quadrants with their bounds and shape counts
 */
function getBoardQuadrants(boardBounds: BoardBounds, shapes: Map<string, ShapeInfo>): QuadrantInfo[] {
  const { x, y, width, height, centerX, centerY } = boardBounds;

  const quadrants: QuadrantInfo[] = [
    {
      name: "top-left",
      bounds: {
        x,
        y,
        width: centerX - x,
        height: centerY - y,
        centerX: x + (centerX - x) / 2,
        centerY: y + (centerY - y) / 2,
      },
      shapeCount: 0,
    },
    {
      name: "top-right",
      bounds: {
        x: centerX,
        y,
        width: x + width - centerX,
        height: centerY - y,
        centerX: centerX + (x + width - centerX) / 2,
        centerY: y + (centerY - y) / 2,
      },
      shapeCount: 0,
    },
    {
      name: "bottom-left",
      bounds: {
        x,
        y: centerY,
        width: centerX - x,
        height: y + height - centerY,
        centerX: x + (centerX - x) / 2,
        centerY: centerY + (y + height - centerY) / 2,
      },
      shapeCount: 0,
    },
    {
      name: "bottom-right",
      bounds: {
        x: centerX,
        y: centerY,
        width: x + width - centerX,
        height: y + height - centerY,
        centerX: centerX + (x + width - centerX) / 2,
        centerY: centerY + (y + height - centerY) / 2,
      },
      shapeCount: 0,
    },
  ];

  // Count shapes in each quadrant
  for (const shape of shapes.values()) {
    const { center } = shape;
    for (const quadrant of quadrants) {
      const qb = quadrant.bounds;
      if (center.x >= qb.x && center.x < qb.x + qb.width &&
          center.y >= qb.y && center.y < qb.y + qb.height) {
        quadrant.shapeCount++;
        break;
      }
    }
  }

  return quadrants;
}

/**
 * Detect empty regions vs regions with content (Req 10.3, 3.5)
 * Returns regions that have no shapes
 */
function detectEmptyRegions(boardBounds: BoardBounds, shapes: Map<string, ShapeInfo>): BoardBounds[] {
  const quadrants = getBoardQuadrants(boardBounds, shapes);
  return quadrants
    .filter(q => q.shapeCount === 0)
    .map(q => q.bounds);
}

/**
 * Calculate center of mass of shape clusters (Req 10.4)
 */
function calculateCenterOfMass(shapes: ShapeInfo[]): { x: number; y: number } | null {
  if (shapes.length === 0) return null;

  const sumX = shapes.reduce((sum, s) => sum + s.center.x, 0);
  const sumY = shapes.reduce((sum, s) => sum + s.center.y, 0);

  return {
    x: sumX / shapes.length,
    y: sumY / shapes.length,
  };
}

/**
 * Suggest optimal placement positions for new content (Req 10.5)
 * Returns positions that avoid existing shapes
 */
function suggestOptimalPlacement(
  editor: Editor,
  boardBounds: BoardBounds,
  shapes: Map<string, ShapeInfo>,
  preferredRegion?: string
): { x: number; y: number }[] {
  const suggestions: { x: number; y: number; region: string }[] = [];

  // Get quadrants and identify empty or less-crowded regions
  const quadrants = getBoardQuadrants(boardBounds, shapes);

  // Sort quadrants by shape count (empty first, then less crowded)
  const sortedQuadrants = [...quadrants].sort((a, b) => a.shapeCount - b.shapeCount);

  // If a preferred region is specified, prioritize it
  let priorityQuadrants = sortedQuadrants;
  if (preferredRegion) {
    const preferred = sortedQuadrants.filter(q => q.name === preferredRegion);
    const others = sortedQuadrants.filter(q => q.name !== preferredRegion);
    priorityQuadrants = [...preferred, ...others];
  }

  // Suggest center of each quadrant as potential placement
  for (const quadrant of priorityQuadrants) {
    suggestions.push({
      x: quadrant.bounds.centerX,
      y: quadrant.bounds.centerY,
      region: quadrant.name,
    });
  }

  // Also suggest the overall center of mass
  const allShapes = Array.from(shapes.values());
  const com = calculateCenterOfMass(allShapes);
  if (com) {
    suggestions.push({ x: com.x, y: com.y, region: "center-of-mass" });
  }

  return suggestions.map(s => ({ x: s.x, y: s.y }));
}

/**
 * Calculate relative position (Req 10.6)
 * Returns position relative to source bounds based on relativeTo direction
 */
function calculateRelativePosition(
  sourceBounds: PageRect,
  relativeTo: RelativePosition,
  offset: number = 20
): { x: number; y: number } {
  const center = getRectCenter(sourceBounds);

  switch (relativeTo) {
    case "left":
      return { x: sourceBounds.x - offset, y: center.y };
    case "right":
      return { x: sourceBounds.x + sourceBounds.w + offset, y: center.y };
    case "above":
      return { x: center.x, y: sourceBounds.y - offset };
    case "below":
      return { x: center.x, y: sourceBounds.y + sourceBounds.h + offset };
    case "top-left":
      return { x: sourceBounds.x - offset, y: sourceBounds.y - offset };
    case "top-right":
      return { x: sourceBounds.x + sourceBounds.w + offset, y: sourceBounds.y - offset };
    case "bottom-left":
      return { x: sourceBounds.x - offset, y: sourceBounds.y + sourceBounds.h + offset };
    case "bottom-right":
      return { x: sourceBounds.x + sourceBounds.w + offset, y: sourceBounds.y + sourceBounds.h + offset };
    case "center":
      return center;
    default:
      return center;
  }
}

/**
 * Get complete position information for the board (Req 10.1-10.5)
 */
function getPositionInfo(editor: Editor, boardState: BoardState): PositionInfo {
  const bounds = getBoardBounds(editor);
  if (!bounds) {
    return {
      bounds: null,
      quadrants: [],
      centerOfMass: null,
      emptyRegions: [],
    };
  }

  const quadrants = getBoardQuadrants(bounds, boardState.shapes);
  const emptyRegions = detectEmptyRegions(bounds, boardState.shapes);
  const centerOfMass = calculateCenterOfMass(Array.from(boardState.shapes.values()));

  return {
    bounds,
    quadrants,
    centerOfMass,
    emptyRegions,
  };
}

// ============================================
// Formula Parsing and Rendering (Req 9.3, 9.4, 9.5, 9.6)
// ============================================

/**
 * Convert a number to superscript characters
 */
function toSuperscript(n: string): string {
  const superscripts: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "n": "ⁿ", "i": "ⁱ", "x": "ˣ", "y": "ʸ"
  };
  return n.split("").map(d => superscripts[d] || d).join("");
}

/**
 * Convert a number to subscript characters
 */
function toSubscript(n: string): string {
  const subscripts: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "o": "ₒ", "x": "ₓ", "h": "ₕ",
    "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "p": "ₚ",
    "s": "ₛ", "t": "ₜ"
  };
  return n.split("").map(d => subscripts[d] || d).join("");
}

/**
 * Validate formula syntax - check for balanced parentheses
 */
function isValidFormula(formula: string): boolean {
  if (!formula || typeof formula !== "string") {
    return false;
  }
  
  // Check for balanced parentheses
  let depth = 0;
  for (const char of formula) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Parse formula string to display format
 * Converts common math notation to Unicode symbols
 */
function parseFormula(formula: string): string {
  if (!formula || typeof formula !== "string") {
    return "";
  }
  
  let result = formula;
  
  // Superscript: ^number or ^(expression)
  result = result.replace(/\^(\d+)/g, (_, num) => toSuperscript(num));
  result = result.replace(/\^\(([^)]+)\)/g, (_, expr) => toSuperscript(expr));
  
  // Subscript: _number or _(expression)
  result = result.replace(/_(\d+)/g, (_, num) => toSubscript(num));
  result = result.replace(/_\(([^)]+)\)/g, (_, expr) => toSubscript(expr));
  
  // Square root
  result = result.replace(/sqrt\(([^)]+)\)/g, "√($1)");
  result = result.replace(/√\(([^)]+)\)/g, "√($1)");
  
  // Nth root
  result = result.replace(/root(\d+)\(([^)]+)\)/g, "∛$2");
  result = result.replace(/cbrt\(([^)]+)\)/g, "∛($1)");
  
  // Fractions: 1/2 -> ½
  result = result.replace(/(\d+)\/(\d+)/g, (_, num, den) => {
    const fractionMap: Record<string, string> = {
      "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾",
      "1/5": "⅕", "2/5": "⅖", "3/5": "⅗", "4/5": "⅘",
      "1/6": "⅙", "1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞"
    };
    return fractionMap[`${num}/${den}`] || `${num}/${den}`;
  });
  
  // Greek letters
  const greekLetters: [RegExp, string][] = [
    [/pi/gi, "π"],
    [/theta/gi, "θ"],
    [/alpha/gi, "α"],
    [/beta/gi, "β"],
    [/gamma/gi, "γ"],
    [/delta/gi, "δ"],
    [/epsilon/gi, "ε"],
    [/lambda/gi, "λ"],
    [/mu/gi, "μ"],
    [/sigma/gi, "σ"],
    [/phi/gi, "φ"],
    [/omega/gi, "ω"],
    [/rho/gi, "ρ"],
    [/tau/gi, "τ"],
    [/eta/gi, "η"],
    [/psi/gi, "ψ"],
    [/zeta/gi, "ζ"],
    [/chi/gi, "χ"],
    [/nu/gi, "ν"],
    [/xi/gi, "ξ"],
    [/omicron/gi, "ο"]
  ];
  
  for (const [pattern, replacement] of greekLetters) {
    result = result.replace(pattern, replacement);
  }
  
  // Math symbols
  const mathSymbols: [RegExp, string][] = [
    [/infty/gi, "∞"],
    [/infinity/gi, "∞"],
    [/sum/gi, "Σ"],
    [/product/gi, "Π"],
    [/int/gi, "∫"],
    [/partial/gi, "∂"],
    [/nabla/gi, "∇"],
    [/pm/gi, "±"],
    [/mp/gi, "∓"],
    [/times/gi, "×"],
    [/div/gi, "÷"],
    [/neq/gi, "≠"],
    [/le/gi, "≤"],
    [/ge/gi, "≥"],
    [/approx/gi, "≈"],
    [/equiv/gi, "≡"],
    [/cdot/gi, "·"],
    [/cdots/gi, "⋯"],
    [/ldots/gi, "…"],
    [/rightarrow/gi, "→"],
    [/leftarrow/gi, "←"],
    [/Rightarrow/gi, "⇒"],
    [/Leftarrow/gi, "⇐"],
    [/forall/gi, "∀"],
    [/exists/gi, "∃"],
    [/neg/gi, "¬"],
    [/cap/gi, "∩"],
    [/cup/gi, "∪"],
    [/subset/gi, "⊂"],
    [/supset/gi, "⊃"],
    [/in/gi, "∈"],
    [/notin/gi, "∉"],
    [/perp/gi, "⊥"],
    [/parallel/gi, "∥"],
    [/angle/gi, "∠"],
    [/degree/gi, "°"],
    [/prime/gi, "′"],
    [/doubleprime/gi, "″"]
  ];
  
  for (const [pattern, replacement] of mathSymbols) {
    result = result.replace(pattern, replacement);
  }
  
  return result;
}

// ============================================
// Side Label Positioning (Req 6.1, 6.2, 6.3, 6.4)
// ============================================

/**
 * Calculate position for a label on a specific side of a shape
 * @param shapeBounds - The bounding box of the target shape
 * @param side - Which side of the shape (top, bottom, left, right)
 * @param labelSide - Label placement type: "normal" = outside, "inverted" = inside, "side-inverted" = on edge
 * @param offset - Distance from shape edge (default: 10)
 * @returns Position and rotation for the label
 */
function calculateSideLabelPosition(
  shapeBounds: PageRect,
  side: LabelPosition,
  labelSide: LabelSide,
  offset: number = 10
): { x: number; y: number; rotation: number } {
  const center = getRectCenter(shapeBounds);

  switch (labelSide) {
    case "normal": // Outside the shape
      switch (side) {
        case "top":
          return { x: center.x, y: shapeBounds.y - offset, rotation: 0 };
        case "bottom":
          return { x: center.x, y: shapeBounds.y + shapeBounds.h + offset, rotation: 0 };
        case "left":
          return { x: shapeBounds.x - offset, y: center.y, rotation: -90 };
        case "right":
          return { x: shapeBounds.x + shapeBounds.w + offset, y: center.y, rotation: 90 };
      }
      break;
    case "inverted": // Inside the shape
      switch (side) {
        case "top":
          return { x: center.x, y: shapeBounds.y + offset * 2, rotation: 0 };
        case "bottom":
          return { x: center.x, y: shapeBounds.y + shapeBounds.h - offset * 2, rotation: 0 };
        case "left":
          return { x: shapeBounds.x + offset * 2, y: center.y, rotation: -90 };
        case "right":
          return { x: shapeBounds.x + shapeBounds.w - offset * 2, y: center.y, rotation: 90 };
      }
      break;
    case "side-inverted": // On the edge
      switch (side) {
        case "top":
          return { x: center.x, y: shapeBounds.y, rotation: 0 };
        case "bottom":
          return { x: center.x, y: shapeBounds.y + shapeBounds.h, rotation: 0 };
        case "left":
          return { x: shapeBounds.x, y: center.y, rotation: -90 };
        case "right":
          return { x: shapeBounds.x + shapeBounds.w, y: center.y, rotation: 90 };
      }
      break;
  }
  return { x: center.x, y: center.y, rotation: 0 };
}

/**
 * Get the label position side from a position string
 * Converts various position descriptions to standard side
 */
function getLabelSideFromPosition(position: string): LabelPosition {
  switch (position.toLowerCase()) {
    case "above":
    case "top":
    case "north":
      return "top";
    case "below":
    case "bottom":
    case "south":
      return "bottom";
    case "left":
    case "west":
      return "left";
    case "right":
    case "east":
      return "right";
    default:
      return "top";
  }
}

// ============================================
// 3D Projection Utilities (Req 8.1-8.6)
// ============================================

interface Face {
  points: Point[];
  color: string;
}

interface Edge {
  start: Point;
  end: Point;
}

interface EdgeLabel {
  position: Point;
  text: string;
}

/**
 * Isometric projection angle (30 degrees from horizontal)
 * This creates the classic isometric view where:
 * - X axis goes down-right at 30°
 * - Y axis goes down-left at 150°  
 * - Z axis goes straight up
 */
const ISO_ANGLE = Math.PI / 6; // 30 degrees
const COS_ISO = Math.cos(ISO_ANGLE);
const SIN_ISO = Math.sin(ISO_ANGLE);

/**
 * Convert 3D coordinates to 2D isometric projection
 */
function project3D(x: number, y: number, z: number): Point {
  return {
    x: (x - y) * COS_ISO,
    y: (x + y) * SIN_ISO - z,
  };
}

/**
 * Calculate visible faces and edges for a cube
 */
function calculateCubeProjection(
  cx: number,
  cy: number,
  size: number
): { faces: Face[]; edges: Edge[] } {
  const half = size / 2;
  
  // 8 vertices of a cube centered at origin
  const vertices: [number, number, number][] = [
    [-half, -half, -half], // 0: back-bottom-left
    [half, -half, -half],  // 1: back-bottom-right
    [half, half, -half],   // 2: back-top-right
    [-half, half, -half],  // 3: back-top-left
    [-half, -half, half],  // 4: front-bottom-left
    [half, -half, half],   // 5: front-bottom-right
    [half, half, half],    // 6: front-top-right
    [-half, half, half],   // 7: front-top-left
  ];

  // Project all vertices
  const projected = vertices.map(([x, y, z]) => ({
    x: cx + project3D(x, y, z).x,
    y: cy + project3D(x, y, z).y,
  }));

  // Visible faces: top, front-left, front-right
  const faces: Face[] = [
    // Top face (vertices 4,5,6,7)
    {
      points: [projected[4], projected[5], projected[6], projected[7]],
      color: "#94a3b8", // lighter top
    },
    // Front-left face (vertices 0,3,7,4)
    {
      points: [projected[0], projected[3], projected[7], projected[4]],
      color: "#64748b", // medium left
    },
    // Front-right face (vertices 0,1,5,4)
    {
      points: [projected[0], projected[1], projected[5], projected[4]],
      color: "#475569", // darker right
    },
  ];

  // Visible edges (outer edges of visible faces)
  const edges: Edge[] = [
    // Top face edges
    { start: projected[4], end: projected[5] },
    { start: projected[5], end: projected[6] },
    { start: projected[6], end: projected[7] },
    { start: projected[7], end: projected[4] },
    // Vertical edges from top
    { start: projected[4], end: projected[0] },
    { start: projected[7], end: projected[3] },
    // Bottom front edge
    { start: projected[0], end: projected[1] },
    { start: projected[1], end: projected[5] },
  ];

  return { faces, edges };
}

/**
 * Calculate visible faces and edges for a rectangular prism
 */
function calculatePrismProjection(
  cx: number,
  cy: number,
  width: number,
  height: number,
  depth: number
): { faces: Face[]; edges: Edge[] } {
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;

  // 8 vertices
  const vertices: [number, number, number][] = [
    [-hw, -hd, -hh],
    [hw, -hd, -hh],
    [hw, hd, -hh],
    [-hw, hd, -hh],
    [-hw, -hd, hh],
    [hw, -hd, hh],
    [hw, hd, hh],
    [-hw, hd, hh],
  ];

  const projected = vertices.map(([x, y, z]) => ({
    x: cx + project3D(x, y, z).x,
    y: cy + project3D(x, y, z).y,
  }));

  const faces: Face[] = [
    // Top
    {
      points: [projected[4], projected[5], projected[6], projected[7]],
      color: "#94a3b8",
    },
    // Front-left
    {
      points: [projected[0], projected[3], projected[7], projected[4]],
      color: "#64748b",
    },
    // Front-right
    {
      points: [projected[0], projected[1], projected[5], projected[4]],
      color: "#475569",
    },
  ];

  const edges: Edge[] = [
    { start: projected[4], end: projected[5] },
    { start: projected[5], end: projected[6] },
    { start: projected[6], end: projected[7] },
    { start: projected[7], end: projected[4] },
    { start: projected[4], end: projected[0] },
    { start: projected[7], end: projected[3] },
    { start: projected[0], end: projected[1] },
    { start: projected[1], end: projected[5] },
  ];

  return { faces, edges };
}

/**
 * Calculate visible faces and edges for a triangular prism
 */
function calculateTriangularPrismProjection(
  cx: number,
  cy: number,
  width: number,
  height: number,
  depth: number
): { faces: Face[]; edges: Edge[] } {
  const hw = width / 2;
  const hd = depth / 2;

  // 6 vertices of triangular prism
  const vertices: [number, number, number][] = [
    [-hw, -hd, 0],      // 0: back-bottom
    [hw, -hd, 0],       // 1: back-top
    [0, -hd, height],   // 2: back-front
    [-hw, hd, 0],       // 3: front-bottom
    [hw, hd, 0],        // 4: front-top
    [0, hd, height],    // 5: front-front
  ];

  const projected = vertices.map(([x, y, z]) => ({
    x: cx + project3D(x, y, z).x,
    y: cy + project3D(x, y, z).y,
  }));

  const faces: Face[] = [
    // Top face
    {
      points: [projected[0], projected[1], projected[2]],
      color: "#94a3b8",
    },
    // Front-left
    {
      points: [projected[0], projected[3], projected[5], projected[2]],
      color: "#64748b",
    },
    // Front-right
    {
      points: [projected[0], projected[1], projected[4], projected[3]],
      color: "#475569",
    },
  ];

  const edges: Edge[] = [
    // Top triangle
    { start: projected[0], end: projected[1] },
    { start: projected[1], end: projected[2] },
    { start: projected[2], end: projected[0] },
    // Front triangle
    { start: projected[3], end: projected[4] },
    { start: projected[4], end: projected[5] },
    { start: projected[5], end: projected[3] },
    // Connecting edges
    { start: projected[0], end: projected[3] },
    { start: projected[1], end: projected[4] },
    { start: projected[2], end: projected[5] },
  ];

  return { faces, edges };
}

/**
 * Calculate visible faces and edges for a cylinder
 */
function calculateCylinderProjection(
  cx: number,
  cy: number,
  radius: number,
  height: number
): { faces: Face[]; edges: Edge[] } {
  const segments = 16;
  const angleStep = (2 * Math.PI) / segments;

  // Generate ellipse points for top and bottom
  const topPoints: Point[] = [];
  const bottomPoints: Point[] = [];

  for (let i = 0; i < segments; i++) {
    const angle = i * angleStep;
    // Flatten y-axis for isometric view (0.5 ratio)
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * 0.5 * Math.sin(angle);

    topPoints.push({ x, y: y - height });
    bottomPoints.push({ x, y });
  }

  // Create body as a polygon
  const bodyPoints = [...bottomPoints, ...topPoints.reverse()];

  const faces: Face[] = [
    // Top ellipse (simplified as polygon)
    {
      points: topPoints,
      color: "#94a3b8",
    },
    // Body
    {
      points: bodyPoints,
      color: "#64748b",
    },
  ];

  // Edges: top ellipse outline, bottom ellipse outline
  const edges: Edge[] = [];
  
  for (let i = 0; i < segments; i++) {
    // Top edges
    edges.push({ start: topPoints[i], end: topPoints[(i + 1) % segments] });
    // Bottom edges
    edges.push({ start: bottomPoints[i], end: bottomPoints[(i + 1) % segments] });
  }

  return { faces, edges };
}

/**
 * Calculate visible faces and edges for a cone
 */
function calculateConeProjection(
  cx: number,
  cy: number,
  radius: number,
  height: number
): { faces: Face[]; edges: Edge[] } {
  const segments = 16;
  const angleStep = (2 * Math.PI) / segments;

  // Generate ellipse points for base
  const basePoints: Point[] = [];
  const apex = { x: cx, y: cy - height };

  for (let i = 0; i < segments; i++) {
    const angle = i * angleStep;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * 0.5 * Math.sin(angle);
    basePoints.push({ x, y });
  }

  const faces: Face[] = [
    // Base (ellipse)
    {
      points: basePoints,
      color: "#475569",
    },
    // Body (triangular faces simplified as one shape)
    {
      points: [apex, ...basePoints],
      color: "#64748b",
    },
  ];

  // Edges: base ellipse + lines to apex
  const edges: Edge[] = [];

  for (let i = 0; i < segments; i++) {
    edges.push({ start: basePoints[i], end: basePoints[(i + 1) % segments] });
    edges.push({ start: apex, end: basePoints[i] });
  }

  return { faces, edges };
}

/**
 * Calculate visible faces and edges for a pyramid (square base)
 */
function calculatePyramidProjection(
  cx: number,
  cy: number,
  baseSize: number,
  height: number
): { faces: Face[]; edges: Edge[] } {
  const half = baseSize / 2;
  const apex = { x: cx, y: cy - height };

  // Base vertices (front half only visible)
  const baseFrontLeft = { x: cx - half, y: cy + half * 0.5 };
  const baseFrontRight = { x: cx + half, y: cy + half * 0.5 };
  const baseBackLeft = { x: cx - half, y: cy - half * 0.5 };
  const baseBackRight = { x: cx + half, y: cy - half * 0.5 };

  const faces: Face[] = [
    // Front-left face
    {
      points: [baseBackLeft, baseFrontLeft, apex],
      color: "#64748b",
    },
    // Front-right face
    {
      points: [baseFrontLeft, baseFrontRight, apex],
      color: "#94a3b8",
    },
    // Back (partially visible)
    {
      points: [baseBackRight, baseBackLeft, baseFrontRight],
      color: "#475569",
    },
  ];

  const edges: Edge[] = [
    // Base edges
    { start: baseBackLeft, end: baseFrontLeft },
    { start: baseFrontLeft, end: baseFrontRight },
    { start: baseFrontRight, end: baseBackRight },
    { start: baseBackRight, end: baseBackLeft },
    // Apex edges
    { start: apex, end: baseBackLeft },
    { start: apex, end: baseFrontLeft },
    { start: apex, end: baseFrontRight },
  ];

  return { faces, edges };
}

/**
 * Create edge labels for 3D shapes
 */
function createEdgeLabels(
  edges: Edge[],
  labels?: string[]
): EdgeLabel[] {
  if (!labels || labels.length === 0) return [];

  return edges.map((edge, index) => ({
    position: {
      x: (edge.start.x + edge.end.x) / 2,
      y: (edge.start.y + edge.end.y) / 2 - 8,
    },
    text: labels[index] || "",
  })).filter(label => label.text !== "");
}

type CreateShapeInput = Parameters<Editor["createShape"]>[0];

type PageRect = { x: number; y: number; w: number; h: number };

// ============================================
// Grid Snap Types (Req 12.3)
// ============================================

interface GridSnapOptions {
  enabled: boolean;
  gridSize: number; // Default: 20
}

type AlignmentPoint = 
  | "center" 
  | "top" 
  | "bottom" 
  | "left" 
  | "right" 
  | "top-left" 
  | "top-right" 
  | "bottom-left" 
  | "bottom-right" 
  | "top-center" 
  | "bottom-center" 
  | "middle-left" 
  | "middle-right";

// ============================================
// Grid Snap Functions (Req 12.3)
// ============================================

/**
 * Snap a point to the nearest grid intersection
 */
function snapToGrid(point: { x: number; y: number }, gridSize: number = 20): { x: number; y: number } {
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  };
}

/**
 * Snap all bounds (position and dimensions) to grid
 */
function snapBoundsToGrid(bounds: PageRect, gridSize: number = 20): PageRect {
  return {
    x: Math.round(bounds.x / gridSize) * gridSize,
    y: Math.round(bounds.y / gridSize) * gridSize,
    w: Math.round(bounds.w / gridSize) * gridSize,
    h: Math.round(bounds.h / gridSize) * gridSize,
  };
}

// ============================================
// Alignment Functions (Req 12.4)
// ============================================

/**
 * Get the anchor point for a given alignment point on a rectangle
 */
function getAnchorPoint(bounds: PageRect, point: AlignmentPoint): { x: number; y: number } {
  const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  
  switch (point) {
    case "center":
      return center;
    case "top":
      return { x: center.x, y: bounds.y };
    case "bottom":
      return { x: center.x, y: bounds.y + bounds.h };
    case "left":
      return { x: bounds.x, y: center.y };
    case "right":
      return { x: bounds.x + bounds.w, y: center.y };
    case "top-left":
      return { x: bounds.x, y: bounds.y };
    case "top-right":
      return { x: bounds.x + bounds.w, y: bounds.y };
    case "bottom-left":
      return { x: bounds.x, y: bounds.y + bounds.h };
    case "bottom-right":
      return { x: bounds.x + bounds.w, y: bounds.y + bounds.h };
    case "top-center":
      return { x: center.x, y: bounds.y };
    case "bottom-center":
      return { x: center.x, y: bounds.y + bounds.h };
    case "middle-left":
      return { x: bounds.x, y: center.y };
    case "middle-right":
      return { x: bounds.x + bounds.w, y: center.y };
    default:
      return center;
  }
}

/**
 * Align a source shape to a target shape at specified alignment points
 * Returns the new position for the source shape
 */
function alignToReference(
  sourceBounds: PageRect,
  targetBounds: PageRect,
  sourcePoint: AlignmentPoint,
  targetPoint: AlignmentPoint
): { x: number; y: number } {
  // Get the anchor points
  const sourceAnchor = getAnchorPoint(sourceBounds, sourcePoint);
  const targetAnchor = getAnchorPoint(targetBounds, targetPoint);
  
  // Calculate offset needed to align source anchor to target anchor
  return {
    x: targetAnchor.x - (sourceAnchor.x - sourceBounds.x),
    y: targetAnchor.y - (sourceAnchor.y - sourceBounds.y),
  };
}

// ============================================
// Position Intelligence Types (Req 10.1-10.6)
// ============================================

type RelativePosition = 
  | "left" 
  | "right" 
  | "above" 
  | "below" 
  | "top-left" 
  | "top-right" 
  | "bottom-left" 
  | "bottom-right" 
  | "center";

interface BoardBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

interface QuadrantInfo {
  name: string;
  bounds: BoardBounds;
  shapeCount: number;
}

interface PositionInfo {
  bounds: BoardBounds | null;
  quadrants: QuadrantInfo[];
  centerOfMass: { x: number; y: number } | null;
  emptyRegions: BoardBounds[];
}

type BoardTargetState = {
  lastPointerPagePoint: { x: number; y: number } | null;
  pointerShapeId: string | null;
  thisShapeId: string | null;
  thatShapeId: string | null;
};

function updateFocusHistory(state: BoardTargetState, shapeId: string | null) {
  if (!shapeId || state.thisShapeId === shapeId) {
    return;
  }

  state.thatShapeId = state.thisShapeId;
  state.thisShapeId = shapeId;
}

/**
 * Update both target state and board state focus history
 */
function updateAllFocusHistory(
  targetState: BoardTargetState,
  boardState: BoardState,
  shapeId: string | null
) {
  if (!shapeId) return;
  
  // Update target state
  updateFocusHistory(targetState, shapeId);
  
  // Update board state focus history
  // Shift "this" to "that" and add new "this"
  const existingThis = targetState.thisShapeId;
  const existingThat = targetState.thatShapeId;
  
  if (existingThis && existingThis !== shapeId) {
    updateBoardFocusHistory(boardState, existingThis, "that");
  }
  if (shapeId) {
    updateBoardFocusHistory(boardState, shapeId, "this");
  }
}

function getShapeBounds(editor: Editor, shapeId: string): PageRect | null {
  const shape = editor.getShape(shapeId as any);
  if (!shape) return null;

  const bounds = editor.getShapePageBounds(shape);
  if (!bounds) return null;

  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
}

function getRectCenter(rect: PageRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function getEdgePointTowards(rect: PageRect, towards: { x: number; y: number }) {
  const center = getRectCenter(rect);
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;

  if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) {
    return center;
  }

  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (rect.w / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (rect.h / 2) / Math.abs(dy);
  const t = Math.min(scaleX, scaleY);

  return {
    x: center.x + dx * t,
    y: center.y + dy * t,
  };
}

function getPlacementPoint(
  rect: PageRect,
  placement: "center" | "top" | "bottom" | "left" | "right",
  offset: number
) {
  const center = getRectCenter(rect);

  switch (placement) {
    case "center":
      return center;
    case "top":
      return { x: center.x, y: rect.y - offset };
    case "bottom":
      return { x: center.x, y: rect.y + rect.h + offset };
    case "left":
      return { x: rect.x - offset, y: center.y };
    case "right":
      return { x: rect.x + rect.w + offset, y: center.y };
    default:
      return { x: center.x, y: rect.y - offset };
  }
}

function resolveTargetShapeId(
  editor: Editor,
  target: BoardTargetRef,
  targetState: BoardTargetState
): string | null {
  switch (target.kind) {
    case "shape_id":
      return editor.getShape(target.shapeId as any) ? target.shapeId : null;
    case "selection": {
      const selection = editor.getSelectedShapeIds();
      if (selection.length === 0) return null;
      const index =
        typeof target.index === "number" && Number.isInteger(target.index)
          ? Math.max(0, Math.min(target.index, selection.length - 1))
          : 0;
      return selection[index] ?? null;
    }
    case "pointer": {
      if (targetState.pointerShapeId && editor.getShape(targetState.pointerShapeId as any)) {
        return targetState.pointerShapeId;
      }

      const pointer = targetState.lastPointerPagePoint;
      if (!pointer) return null;
      const hit = editor.getShapeAtPoint(pointer, {
        hitInside: true,
        hitLabels: true,
        renderingOnly: true,
      });
      return hit?.id ?? null;
    }
    case "this":
      return targetState.thisShapeId && editor.getShape(targetState.thisShapeId as any)
        ? targetState.thisShapeId
        : null;
    case "that":
      return targetState.thatShapeId && editor.getShape(targetState.thatShapeId as any)
        ? targetState.thatShapeId
        : null;
    default:
      return null;
  }
}

function getBoardMetrics(editor: Editor | null): BoardMetrics {
  if (!editor) {
    return {
      summary: "The board is loading. No shapes have been captured yet.",
      shapeCount: 0,
      selectedCount: 0,
    };
  }

  const shapes = editor.getCurrentPageShapes();
  const selectedShapeIds = editor.getSelectedShapeIds();

  if (shapes.length === 0) {
    return {
      summary: "The board is empty right now.",
      shapeCount: 0,
      selectedCount: selectedShapeIds.length,
    };
  }

  const typeCounts = shapes.reduce<Record<string, number>>((counts, shape) => {
    counts[shape.type] = (counts[shape.type] ?? 0) + 1;
    return counts;
  }, {});

  const summary = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  return {
    summary: `${shapes.length} shapes on the board (${summary}). ${selectedShapeIds.length} selected.`,
    shapeCount: shapes.length,
    selectedCount: selectedShapeIds.length,
  };
}

function applyBoardCommand(
  editor: Editor,
  command: BoardCommand,
  targetState: BoardTargetState,
  boardState: BoardState
): CommandResult {
  const commandId = command.id || "unknown";
  console.log("[applyBoardCommand] Processing command:", command.op, command);
  
  // Validate command before execution (Req 11.3)
  const validation = validateCommand(command);
  if (!validation.valid) {
    const result: CommandResult = {
      success: false,
      commandId,
      error: validation.error,
    };
    logCommand(command, result);
    return result;
  }

  // Track created shape IDs for logging
  const createdShapeIds: string[] = [];
  
  try {
    switch (command.op) {
      case "create_text": {
        if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
          console.warn("Skipping invalid text command", command);
          break;
        }

        // Get font size with default
        const fontSize = typeof command.fontSize === "number" && Number.isFinite(command.fontSize)
          ? Math.max(8, Math.min(command.fontSize, 200))
          : undefined;

        // Get color with default
        const textColor = command.color && typeof command.color === "string" 
          ? command.color 
          : undefined;

        editor.createShape({
          type: "text",
          x: command.x,
          y: command.y,
          props: {
            richText: toRichText(command.text),
            ...(fontSize && { fontSize }),
            ...(textColor && { color: textColor }),
          },
        } as unknown as CreateShapeInput);
        
        // Track that a shape was created (we can't get the ID from the sync API)
        createdShapeIds.push("created");
        break;
      }
      // ============================================
      // Multiline Text Command (Req 9.2)
      // ============================================
      case "create_multiline_text": {
        const { lines, x, y, fontSize, color, alignment, lineSpacing } = command;

        // Validate required parameters
        if (!lines || !Array.isArray(lines) || lines.length === 0) {
          console.warn("Skipping create_multiline_text, missing lines", command);
          break;
        }

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          console.warn("Skipping create_multiline_text, invalid position", command);
          break;
        }

        // Get font size with default
        const size = typeof fontSize === "number" && Number.isFinite(fontSize)
          ? Math.max(8, Math.min(fontSize, 200))
          : 24;

        // Get color with default
        const textColor = color && typeof color === "string" ? color : "#1e293b";

        // Get line spacing (default 1.2x font size)
        const spacing = typeof lineSpacing === "number" && Number.isFinite(lineSpacing)
          ? lineSpacing
          : size * 1.2;

        // Get alignment (default left)
        const align = alignment ?? "left";

        // Estimate character width for alignment (approximate)
        const charWidth = size * 0.6;

        // Create each line of text
        let createdShapeIds: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || typeof line !== "string") continue;

          const lineY = y + i * spacing;

          // Calculate X offset based on alignment
          let lineX = x;
          if (align === "center") {
            const lineWidth = line.length * charWidth;
            lineX = x - lineWidth / 2;
          } else if (align === "right") {
            const lineWidth = line.length * charWidth;
            lineX = x - lineWidth;
          }

          const shapeId = editor.createShape({
            type: "text",
            x: lineX,
            y: lineY,
            props: {
              richText: toRichText(line),
              fontSize: size,
              color: textColor,
            },
          } as unknown as CreateShapeInput);

          createdShapeIds.push("created");
        }

        console.log("Created multiline text with", createdShapeIds.length, "lines");
        break;
      }
      case "create_text_near_selection": {
        const bounds = editor.getSelectionPageBounds();
        if (!bounds) {
          console.warn("Skipping create_text_near_selection with no selection", command);
          break;
        }

        const offsetX =
          typeof command.offsetX === "number" && Number.isFinite(command.offsetX)
            ? command.offsetX
            : 0;
        const offsetY =
          typeof command.offsetY === "number" && Number.isFinite(command.offsetY)
            ? command.offsetY
            : 0;
        const anchorX = bounds.x + bounds.w / 2 + offsetX;
        const anchorY = bounds.y + bounds.h / 2 + offsetY;

        const textShapeId = editor.createShape({
          type: "text",
          x: anchorX,
          y: anchorY,
          props: {
            richText: toRichText(command.text),
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      // ============================================
      // Formula Commands (Req 9.3, 9.4, 9.5, 9.6)
      // ============================================
      case "create_formula": {
        const { formula, x, y, fontSize, color } = command;

        // Validate required parameters
        if (!formula || typeof formula !== "string") {
          console.warn("Skipping create_formula, missing formula", command);
          break;
        }

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          console.warn("Skipping create_formula, invalid position", command);
          break;
        }

        // Validate formula syntax
        if (!isValidFormula(formula)) {
          console.warn("Skipping create_formula, invalid formula syntax", command);
          break;
        }

        // Parse formula to display format
        const parsedFormula = parseFormula(formula);

        // Get font size with default
        const size = typeof fontSize === "number" && Number.isFinite(fontSize) 
          ? Math.max(8, Math.min(fontSize, 200)) 
          : 24;

        // Get color with default
        const textColor = color && typeof color === "string" ? color : "#1e293b";

        const formulaShapeId = editor.createShape({
          type: "text",
          x: x,
          y: y,
          props: {
            richText: toRichText(parsedFormula),
            color: textColor,
            fontSize: size,
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      case "create_geo": {
        if (
          !Number.isFinite(command.x) ||
          !Number.isFinite(command.y) ||
          !Number.isFinite(command.w) ||
          !Number.isFinite(command.h)
        ) {
          console.warn("Skipping invalid geo command", command);
          break;
        }

        // Map common shape names to valid tldraw geo types
        const geoType = (command.geo || "rectangle").toLowerCase();
        const geoTypeMap: Record<string, string> = {
          // Circle variants
          circle: "ellipse",
          // Rectangle variants
          box: "rectangle",
          square: "rectangle",
          // Triangle variants
          right_triangle: "triangle",
          righttriangle: "triangle",
          // Arrow is not a valid geo - should use create_arrow command
          arrow: "rectangle",
          // Handle any other invalid types
        };
        const validGeo = geoTypeMap[geoType] || geoType;

        const geoShapeId = editor.createShape({
          type: "geo",
          x: command.x,
          y: command.y,
          props: {
            geo: validGeo,
            w: Math.max(command.w, 40),
            h: Math.max(command.h, 40),
            richText: toRichText(command.label ?? ""),
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      case "create_arrow": {
        const dx = command.toX - command.x;
        const dy = command.toY - command.y;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
          console.warn("Skipping invalid arrow command", command);
          break;
        }

        const arrowShapeId = editor.createShape({
          type: "arrow",
          x: command.x,
          y: command.y,
          props: {
            start: { x: 0, y: 0 },
            end: { x: dx, y: dy },
            richText: toRichText(""),
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      case "create_text_on_target": {
        const targetShapeId = resolveTargetShapeId(editor, command.target, targetState);
        if (!targetShapeId) {
          console.warn("Skipping create_text_on_target, unresolved target", command);
          break;
        }

        const targetBounds = getShapeBounds(editor, targetShapeId);
        if (!targetBounds) {
          console.warn("Skipping create_text_on_target, missing target bounds", command);
          break;
        }

        updateAllFocusHistory(targetState, boardState, targetShapeId);

        const placement = command.placement ?? "top";
        const offset =
          typeof command.offset === "number" && Number.isFinite(command.offset)
            ? Math.max(0, command.offset)
            : 24;
        const anchor = getPlacementPoint(targetBounds, placement, offset);

        const textOnTargetId = editor.createShape({
          type: "text",
          x: anchor.x,
          y: anchor.y,
          props: {
            richText: toRichText(command.text),
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      case "create_arrow_between_targets": {
        const fromShapeId = resolveTargetShapeId(editor, command.from, targetState);
        const toShapeId = resolveTargetShapeId(editor, command.to, targetState);

        if (!fromShapeId || !toShapeId) {
          console.warn("Skipping create_arrow_between_targets, unresolved target", command);
          break;
        }

        const fromBounds = getShapeBounds(editor, fromShapeId);
        const toBounds = getShapeBounds(editor, toShapeId);

        if (!fromBounds || !toBounds) {
          console.warn("Skipping create_arrow_between_targets, missing target bounds", command);
          break;
        }

        updateAllFocusHistory(targetState, boardState, fromShapeId);
        updateAllFocusHistory(targetState, boardState, toShapeId);

        const fromCenter = getRectCenter(fromBounds);
        const toCenter = getRectCenter(toBounds);
        const start = getEdgePointTowards(fromBounds, toCenter);
        const end = getEdgePointTowards(toBounds, fromCenter);
        const dx = end.x - start.x;
        const dy = end.y - start.y;

        const arrowBetweenId = editor.createShape({
          type: "arrow",
          x: start.x,
          y: start.y,
          props: {
            start: { x: 0, y: 0 },
            end: { x: dx, y: dy },
            richText: toRichText(""),
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");

        if (command.label) {
          editor.createShape({
            type: "text",
            x: start.x + dx / 2,
            y: start.y + dy / 2 - 16,
            props: {
              richText: toRichText(command.label),
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }
        break;
      }
      case "create_freehand": {
        // Validate points array has at least 2 points
        if (!command.points || command.points.length < 2) {
          console.warn("Skipping create_freehand, need at least 2 points", command);
          break;
        }

        // Convert points to tldraw format: [[x, y, pressure], ...]
        const drawPoints: [number, number, number][] = command.points.map((p) => [
          p.x,
          p.y,
          0.5, // default pressure
        ]);

        // Calculate center point for shape position
        const sumX = command.points.reduce((sum, p) => sum + p.x, 0);
        const sumY = command.points.reduce((sum, p) => sum + p.y, 0);
        const centerX = sumX / command.points.length;
        const centerY = sumY / command.points.length;

        // Get stroke options with defaults
        const strokeWidth = command.strokeWidth ?? 2;
        const color = command.color ?? "black";

        const freehandId = editor.createShape({
          type: "draw",
          x: centerX,
          y: centerY,
          props: {
            points: drawPoints,
            color: color,
            size: strokeWidth,
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      case "create_freehand_stroke": {
        // Validate points array has at least 2 points
        if (!command.points || command.points.length < 2) {
          console.warn("Skipping create_freehand_stroke, need at least 2 points", command);
          break;
        }

        // Validate required strokeWidth
        if (typeof command.strokeWidth !== "number" || !Number.isFinite(command.strokeWidth) || command.strokeWidth <= 0) {
          console.warn("Skipping create_freehand_stroke, invalid strokeWidth", command);
          break;
        }

        // Validate required color
        if (!command.color || typeof command.color !== "string") {
          console.warn("Skipping create_freehand_stroke, invalid color", command);
          break;
        }

        // Convert points to tldraw format: [[x, y, pressure], ...]
        const drawPoints: [number, number, number][] = command.points.map((p) => [
          p.x,
          p.y,
          0.5, // default pressure
        ]);

        // Calculate center point for shape position
        const sumX = command.points.reduce((sum, p) => sum + p.x, 0);
        const sumY = command.points.reduce((sum, p) => sum + p.y, 0);
        const centerX = sumX / command.points.length;
        const centerY = sumY / command.points.length;

        const freehandStrokeId = editor.createShape({
          type: "draw",
          x: centerX,
          y: centerY,
          props: {
            points: drawPoints,
            color: command.color,
            size: command.strokeWidth,
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      case "clear_board": {
        // Get all shape IDs from the current page
        const allShapeIds = [...editor.getCurrentPageShapeIds()];
        
        if (allShapeIds.length === 0) {
          console.warn("clear_board: No shapes to clear", command);
          break;
        }

        // Delete all shapes - this preserves the board coordinate system
        for (const shapeId of allShapeIds) {
          editor.deleteShape(shapeId);
        }
        break;
      }
      case "clear_shapes": {
        // Validate shapeIds array
        if (!command.shapeIds || !Array.isArray(command.shapeIds)) {
          console.warn("clear_shapes: Invalid shapeIds array", command);
          break;
        }

        if (command.shapeIds.length === 0) {
          console.warn("clear_shapes: Empty shapeIds array", command);
          break;
        }

        // Validate each shape exists before deletion
        const validShapeIds: string[] = [];
        for (const shapeId of command.shapeIds) {
          if (editor.getShape(shapeId as any)) {
            validShapeIds.push(shapeId);
          } else {
            console.warn(`clear_shapes: Shape not found: ${shapeId}`, command);
          }
        }

        if (validShapeIds.length === 0) {
          console.warn("clear_shapes: No valid shapes to delete", command);
          break;
        }

        // Delete the valid shapes
        for (const shapeId of validShapeIds) {
          editor.deleteShape(shapeId as any);
        }
        break;
      }
      case "clear_region": {
        // Validate bounds
        const bounds = command.bounds;
        if (
          !bounds ||
          typeof bounds.x !== "number" ||
          typeof bounds.y !== "number" ||
          typeof bounds.w !== "number" ||
          typeof bounds.h !== "number" ||
          !Number.isFinite(bounds.x) ||
          !Number.isFinite(bounds.y) ||
          !Number.isFinite(bounds.w) ||
          !Number.isFinite(bounds.h) ||
          bounds.w <= 0 ||
          bounds.h <= 0
        ) {
          console.warn("clear_region: Invalid bounds", command);
          break;
        }

        // Get all shapes from the current page
        const allShapes = editor.getCurrentPageShapes();
        
        // Find shapes whose bounds intersect with the clear region
        const shapesToDelete: string[] = [];
        
        for (const shape of allShapes) {
          const shapeBounds = editor.getShapePageBounds(shape);
          if (!shapeBounds) continue;

          // Check if shape bounds intersect with clear region
          const intersects =
            shapeBounds.x < bounds.x + bounds.w &&
            shapeBounds.x + shapeBounds.w > bounds.x &&
            shapeBounds.y < bounds.y + bounds.h &&
            shapeBounds.y + shapeBounds.h > bounds.y;

          if (intersects) {
            shapesToDelete.push(shape.id);
          }
        }

        if (shapesToDelete.length === 0) {
          console.warn("clear_region: No shapes in region to clear", command);
          break;
        }

        // Delete shapes within the region
        for (const shapeId of shapesToDelete) {
          editor.deleteShape(shapeId as any);
        }
        break;
      }
      // ============================================
      // 3D Shape Commands (Req 8.1-8.6)
      // ============================================
      case "create_3d_cube": {
        const { x, y, size, labels } = command;
        
        // Validate parameters
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size) || size <= 0) {
          console.warn("Skipping create_3d_cube, invalid parameters", command);
          break;
        }

        const { faces, edges } = calculateCubeProjection(x, y, size);

        // Create faces as geo shapes
        for (const face of faces) {
          const minX = Math.min(...face.points.map(p => p.x));
          const minY = Math.min(...face.points.map(p => p.y));
          const maxX = Math.max(...face.points.map(p => p.x));
          const maxY = Math.max(...face.points.map(p => p.y));
          const w = Math.max(maxX - minX, 1);
          const h = Math.max(maxY - minY, 1);

          const faceId = editor.createShape({
            type: "geo",
            x: minX,
            y: minY,
            props: {
              geo: "polygon",
              w,
              h,
              fill: face.color,
              color: "#1e293b",
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edges as arrows
        for (const edge of edges) {
          const dx = edge.end.x - edge.start.x;
          const dy = edge.end.y - edge.start.y;

          editor.createShape({
            type: "arrow",
            x: edge.start.x,
            y: edge.start.y,
            props: {
              start: { x: 0, y: 0 },
              end: { x: dx, y: dy },
              color: "#1e293b",
              size: 2,
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edge labels
        if (labels?.edges) {
          const edgeLabels = createEdgeLabels(edges, labels.edges);
          for (const label of edgeLabels) {
            editor.createShape({
              type: "text",
              x: label.position.x,
              y: label.position.y,
              props: {
                richText: toRichText(label.text),
                color: "#1e293b",
                fontSize: 12,
              },
            } as unknown as CreateShapeInput);
            createdShapeIds.push("created");
          }
        }
        break;
      }
      case "create_3d_prism": {
        const { x, y, width, height, depth, type, labels } = command;

        // Validate parameters
        if (!Number.isFinite(x) || !Number.isFinite(y) || 
            !Number.isFinite(width) || width <= 0 ||
            !Number.isFinite(height) || height <= 0 ||
            !Number.isFinite(depth) || depth <= 0) {
          console.warn("Skipping create_3d_prism, invalid parameters", command);
          break;
        }

        let faces: Face[], edges: Edge[];

        if (type === "triangular") {
          const proj = calculateTriangularPrismProjection(x, y, width, height, depth);
          faces = proj.faces;
          edges = proj.edges;
        } else {
          const proj = calculatePrismProjection(x, y, width, height, depth);
          faces = proj.faces;
          edges = proj.edges;
        }

        // Create faces
        for (const face of faces) {
          const minX = Math.min(...face.points.map(p => p.x));
          const minY = Math.min(...face.points.map(p => p.y));
          const maxX = Math.max(...face.points.map(p => p.x));
          const maxY = Math.max(...face.points.map(p => p.y));
          const w = Math.max(maxX - minX, 1);
          const h = Math.max(maxY - minY, 1);

          const prismFaceId = editor.createShape({
            type: "geo",
            x: minX,
            y: minY,
            props: {
              geo: "polygon",
              w,
              h,
              fill: face.color,
              color: "#1e293b",
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edges
        for (const edge of edges) {
          const dx = edge.end.x - edge.start.x;
          const dy = edge.end.y - edge.start.y;

          editor.createShape({
            type: "arrow",
            x: edge.start.x,
            y: edge.start.y,
            props: {
              start: { x: 0, y: 0 },
              end: { x: dx, y: dy },
              color: "#1e293b",
              size: 2,
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edge labels
        if (labels?.edges) {
          const edgeLabels = createEdgeLabels(edges, labels.edges);
          for (const label of edgeLabels) {
            editor.createShape({
              type: "text",
              x: label.position.x,
              y: label.position.y,
              props: {
                richText: toRichText(label.text),
                color: "#1e293b",
                fontSize: 12,
              },
            } as unknown as CreateShapeInput);
            createdShapeIds.push("created");
          }
        }
        break;
      }
      case "create_3d_cylinder": {
        const { x, y, radius, height, labels } = command;

        // Validate parameters
        if (!Number.isFinite(x) || !Number.isFinite(y) || 
            !Number.isFinite(radius) || radius <= 0 ||
            !Number.isFinite(height) || height <= 0) {
          console.warn("Skipping create_3d_cylinder, invalid parameters", command);
          break;
        }

        const { faces, edges } = calculateCylinderProjection(x, y, radius, height);

        // Create faces
        for (const face of faces) {
          const minX = Math.min(...face.points.map(p => p.x));
          const minY = Math.min(...face.points.map(p => p.y));
          const maxX = Math.max(...face.points.map(p => p.x));
          const maxY = Math.max(...face.points.map(p => p.y));
          const w = Math.max(maxX - minX, 1);
          const h = Math.max(maxY - minY, 1);

          const cylFaceId = editor.createShape({
            type: "geo",
            x: minX,
            y: minY,
            props: {
              geo: "ellipse",
              w,
              h,
              fill: face.color,
              color: "#1e293b",
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edges
        for (const edge of edges) {
          const dx = edge.end.x - edge.start.x;
          const dy = edge.end.y - edge.start.y;

          editor.createShape({
            type: "arrow",
            x: edge.start.x,
            y: edge.start.y,
            props: {
              start: { x: 0, y: 0 },
              end: { x: dx, y: dy },
              color: "#1e293b",
              size: 2,
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edge labels
        if (labels?.edges) {
          const edgeLabels = createEdgeLabels(edges, labels.edges);
          for (const label of edgeLabels) {
            editor.createShape({
              type: "text",
              x: label.position.x,
              y: label.position.y,
              props: {
                richText: toRichText(label.text),
                color: "#1e293b",
                fontSize: 12,
              },
            } as unknown as CreateShapeInput);
            createdShapeIds.push("created");
          }
        }
        break;
      }
      case "create_3d_cone": {
        const { x, y, radius, height, labels } = command;

        // Validate parameters
        if (!Number.isFinite(x) || !Number.isFinite(y) || 
            !Number.isFinite(radius) || radius <= 0 ||
            !Number.isFinite(height) || height <= 0) {
          console.warn("Skipping create_3d_cone, invalid parameters", command);
          break;
        }

        const { faces, edges } = calculateConeProjection(x, y, radius, height);

        // Create faces
        for (const face of faces) {
          const minX = Math.min(...face.points.map(p => p.x));
          const minY = Math.min(...face.points.map(p => p.y));
          const maxX = Math.max(...face.points.map(p => p.x));
          const maxY = Math.max(...face.points.map(p => p.y));
          const w = Math.max(maxX - minX, 1);
          const h = Math.max(maxY - minY, 1);

          const coneFaceId = editor.createShape({
            type: "geo",
            x: minX,
            y: minY,
            props: {
              geo: "ellipse",
              w,
              h,
              fill: face.color,
              color: "#1e293b",
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edges
        for (const edge of edges) {
          const dx = edge.end.x - edge.start.x;
          const dy = edge.end.y - edge.start.y;

          editor.createShape({
            type: "arrow",
            x: edge.start.x,
            y: edge.start.y,
            props: {
              start: { x: 0, y: 0 },
              end: { x: dx, y: dy },
              color: "#1e293b",
              size: 2,
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edge labels
        if (labels?.edges) {
          const edgeLabels = createEdgeLabels(edges, labels.edges);
          for (const label of edgeLabels) {
            editor.createShape({
              type: "text",
              x: label.position.x,
              y: label.position.y,
              props: {
                richText: toRichText(label.text),
                color: "#1e293b",
                fontSize: 12,
              },
            } as unknown as CreateShapeInput);
            createdShapeIds.push("created");
          }
        }
        break;
      }
      case "create_3d_pyramid": {
        const { x, y, baseSize, height, labels } = command;

        // Validate parameters
        if (!Number.isFinite(x) || !Number.isFinite(y) || 
            !Number.isFinite(baseSize) || baseSize <= 0 ||
            !Number.isFinite(height) || height <= 0) {
          console.warn("Skipping create_3d_pyramid, invalid parameters", command);
          break;
        }

        const { faces, edges } = calculatePyramidProjection(x, y, baseSize, height);

        // Create faces
        for (const face of faces) {
          const minX = Math.min(...face.points.map(p => p.x));
          const minY = Math.min(...face.points.map(p => p.y));
          const maxX = Math.max(...face.points.map(p => p.x));
          const maxY = Math.max(...face.points.map(p => p.y));
          const w = Math.max(maxX - minX, 1);
          const h = Math.max(maxY - minY, 1);

          const pyrFaceId = editor.createShape({
            type: "geo",
            x: minX,
            y: minY,
            props: {
              geo: "polygon",
              w,
              h,
              fill: face.color,
              color: "#1e293b",
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edges
        for (const edge of edges) {
          const dx = edge.end.x - edge.start.x;
          const dy = edge.end.y - edge.start.y;

          editor.createShape({
            type: "arrow",
            x: edge.start.x,
            y: edge.start.y,
            props: {
              start: { x: 0, y: 0 },
              end: { x: dx, y: dy },
              color: "#1e293b",
              size: 2,
            },
          } as unknown as CreateShapeInput);
          createdShapeIds.push("created");
        }

        // Create edge labels
        if (labels?.edges) {
          const edgeLabels = createEdgeLabels(edges, labels.edges);
          for (const label of edgeLabels) {
            editor.createShape({
              type: "text",
              x: label.position.x,
              y: label.position.y,
              props: {
                richText: toRichText(label.text),
                color: "#1e293b",
                fontSize: 12,
              },
            } as unknown as CreateShapeInput);
            createdShapeIds.push("created");
          }
        }
        break;
      }
      // ============================================
      // Board State Commands (Req 3.1, 3.2)
      // ============================================
      case "get_board_state": {
        // Return board state summary - this is handled via response mechanism
        // The actual response is sent through the room data channel
        const summary = getBoardStateSummary(boardState);
        console.log("Board state:", JSON.stringify(summary, (key, value) => {
          if (value instanceof Map) {
            return Object.fromEntries(value);
          }
          return value;
        }, 2));
        break;
      }
      case "get_shape_info": {
        const shapeId = command.shapeId;
        const shapeInfo = getShapeInfoById(boardState, shapeId);
        console.log("Shape info for", shapeId, ":", shapeInfo);
        break;
      }
      // ============================================
      // Shape Matching Command (Req 5.2)
      // ============================================
      case "match_shapes": {
        const { criteria, limit } = command;
        
        // Validate criteria
        if (!criteria) {
          console.warn("match_shapes: No criteria provided", command);
          break;
        }
        
        // Find matching shapes using the boardState parameter
        const matches = findShapesByProperties(editor, criteria, boardState);
        
        // Apply limit if specified
        const limitedResults = limit && limit > 0 
          ? matches.slice(0, limit) 
          : matches;
        
        console.log("Shape matches for criteria:", JSON.stringify(criteria), 
          "\nResults:", JSON.stringify(limitedResults, (key, value) => {
            if (value instanceof Map) {
              return Object.fromEntries(value);
            }
            return value;
          }, 2));
        break;
      }
      // ============================================
      // Collision Detection Commands (Req 4.1, 4.2, 4.3, 4.4, 4.5)
      // ============================================
      case "place_with_collision_check": {
        const { shape, avoidShapeIds, allowOverlap } = command;

        // Validate the inner shape command
        if (!shape || !shape.op) {
          console.warn("place_with_collision_check: Invalid shape command", command);
          break;
        }

        // Get bounds from the shape command
        const proposedBounds = getBoundsFromCommand(shape);

        if (!proposedBounds) {
          // If we can't determine bounds, just execute the command
          console.warn("place_with_collision_check: Could not determine bounds, executing directly", command);
          applyBoardCommand(editor, shape, targetState, boardState);
          break;
        }

        // Check for collisions
        const collidingIds = findCollidingShapes(
          editor,
          proposedBounds,
          avoidShapeIds
        );

        if (collidingIds.length > 0 && !allowOverlap) {
          // Collision detected and overlap not allowed
          // Find alternative position
          const suggestedPosition = findAlternativePosition(
            editor,
            proposedBounds,
            "right",
            20
          );

          // Create a modified command with the new position
          const modifiedShape = modifyCommandPosition(shape, suggestedPosition);

          if (modifiedShape) {
            // Execute the modified command
            applyBoardCommand(editor, modifiedShape, targetState, boardState);
            console.log("Collision detected, placed at alternative position:", {
              originalPosition: { x: proposedBounds.x, y: proposedBounds.y },
              suggestedPosition,
              collidingIds,
            });
          } else {
            // If we couldn't modify the command, execute original
            applyBoardCommand(editor, shape, targetState, boardState);
            console.log("Collision detected, but could not modify command:", {
              collidingIds,
            });
          }
        } else {
          // No collision or overlap allowed - execute as-is
          applyBoardCommand(editor, shape, targetState, boardState);
          if (collidingIds.length > 0) {
            console.log("Overlap allowed, placed at requested position:", {
              collidingIds,
            });
          }
        }
        break;
      }
      // ============================================
      // Position Intelligence Commands (Req 10.1-10.6)
      // ============================================
      case "get_position_info": {
        const { query } = command;
        const posInfo = getPositionInfo(editor, boardState);

        switch (query) {
          case "bounds":
            console.log("Board bounds:", posInfo.bounds);
            break;
          case "quadrants":
            console.log("Board quadrants:", posInfo.quadrants);
            break;
          case "center_of_mass":
            console.log("Center of mass:", posInfo.centerOfMass);
            break;
          case "empty_regions":
            console.log("Empty regions:", posInfo.emptyRegions);
            break;
          case "all":
          default:
            console.log("Position info:", JSON.stringify(posInfo, (key, value) => {
              if (value instanceof Map) {
                return Object.fromEntries(value);
              }
              return value;
            }, 2));
        }
        break;
      }
      case "calculate_position": {
        const { sourceShapeId, relativeTo, offset } = command;
        const sourceBounds = getShapeBounds(editor, sourceShapeId);

        if (!sourceBounds) {
          console.warn("calculate_position: Shape not found", sourceShapeId);
          break;
        }

        const position = calculateRelativePosition(
          sourceBounds,
          relativeTo,
          offset ?? 20
        );

        console.log("Calculated position:", {
          sourceShapeId,
          relativeTo,
          offset: offset ?? 20,
          position,
        });
        break;
      }
      case "get_distance": {
        const { shapeIdA, shapeIdB } = command;
        const shapeA = boardState.shapes.get(shapeIdA);
        const shapeB = boardState.shapes.get(shapeIdB);

        if (!shapeA || !shapeB) {
          console.warn("get_distance: One or both shapes not found", { shapeIdA, shapeIdB });
          break;
        }

        const distance = calculateShapeDistance(shapeA, shapeB);

        console.log("Distance between shapes:", {
          shapeIdA,
          shapeIdB,
          distance,
          // Verify symmetry: distance from A to B should equal distance from B to A
          symmetric: distance === calculateShapeDistance(shapeB, shapeA),
        });
        break;
      }
      case "suggest_placement": {
        const { preferredRegion } = command;
        const bounds = getBoardBounds(editor);

        if (!bounds) {
          console.warn("suggest_placement: Could not get board bounds");
          break;
        }

        const suggestions = suggestOptimalPlacement(
          editor,
          bounds,
          boardState.shapes,
          preferredRegion
        );

        console.log("Suggested placement positions:", {
          preferredRegion,
          suggestions,
        });
        break;
      }
      // ============================================
      // Side Label Commands (Req 6.1, 6.2, 6.3, 6.4, 6.5)
      // ============================================
      case "create_side_label": {
        const { targetShapeId, text, side, position, offset } = command;

        // Validate target shape exists - cast to TLShapeId
        const targetShape = editor.getShape(targetShapeId as TLShapeId);
        if (!targetShape) {
          console.warn("create_side_label: Target shape not found", targetShapeId);
          break;
        }

        // Get target shape bounds
        const targetBounds = editor.getShapePageBounds(targetShapeId as TLShapeId);
        if (!targetBounds) {
          console.warn("create_side_label: Could not get target bounds", targetShapeId);
          break;
        }

        // Determine which side to place the label
        const labelPosition: LabelPosition = position ?? "top";
        
        // Calculate offset (default 10 if not specified)
        const labelOffset = typeof offset === "number" && Number.isFinite(offset) 
          ? Math.max(0, offset) 
          : 10;

        // Calculate label position based on side and labelSide type
        const { x, y, rotation } = calculateSideLabelPosition(
          targetBounds,
          labelPosition,
          side,
          labelOffset
        );

        // Create the text shape at the calculated position
        const sideLabelId = editor.createShape({
          type: "text",
          x,
          y,
          props: {
            richText: toRichText(text),
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");

        // If rotation is needed, rotate the shape
        if (rotation !== 0) {
          // Get the created shape's ID (most recently created)
          const allShapesSet = editor.getCurrentPageShapeIds();
          const allShapes = Array.from(allShapesSet);
          const createdShapeId = allShapes[allShapes.length - 1];
          
          if (createdShapeId) {
            editor.rotateShapesBy([createdShapeId], rotation);
          }
        }

        console.log("Created side label:", {
          targetShapeId,
          text,
          side,
          position: labelPosition,
          offset: labelOffset,
          labelPosition: { x, y, rotation },
        });
        break;
      }
      // ============================================
      // Grid Snap Commands (Req 12.3)
      // ============================================
      case "snap_to_grid": {
        const { x, y, gridSize } = command;
        const size = typeof gridSize === "number" && Number.isFinite(gridSize) ? gridSize : 20;
        
        const snapped = snapToGrid({ x, y }, size);
        console.log("Snapped to grid:", {
          original: { x, y },
          snapped,
          gridSize: size,
        });
        // This command returns the snapped position - the AI can use it for positioning
        break;
      }
      case "snap_bounds_to_grid": {
        const { x, y, w, h, gridSize } = command;
        const size = typeof gridSize === "number" && Number.isFinite(gridSize) ? gridSize : 20;
        
        const snapped = snapBoundsToGrid({ x, y, w, h }, size);
        console.log("Snapped bounds to grid:", {
          original: { x, y, w, h },
          snapped,
          gridSize: size,
        });
        // This command returns the snapped bounds - the AI can use it for positioning
        break;
      }
      // ============================================
      // Alignment Commands (Req 12.4)
      // ============================================
      case "align_shapes": {
        const { sourceShapeId, targetShapeId, sourcePoint, targetPoint } = command;
        
        // Get source shape bounds
        const sourceShape = editor.getShape(sourceShapeId as TLShapeId);
        if (!sourceShape) {
          console.warn("align_shapes: Source shape not found", sourceShapeId);
          break;
        }
        
        const sourceBounds = editor.getShapePageBounds(sourceShapeId as TLShapeId);
        if (!sourceBounds) {
          console.warn("align_shapes: Could not get source shape bounds", sourceShapeId);
          break;
        }
        
        // Get target shape bounds
        const targetShape = editor.getShape(targetShapeId as TLShapeId);
        if (!targetShape) {
          console.warn("align_shapes: Target shape not found", targetShapeId);
          break;
        }
        
        const targetBounds = editor.getShapePageBounds(targetShapeId as TLShapeId);
        if (!targetBounds) {
          console.warn("align_shapes: Could not get target shape bounds", targetShapeId);
          break;
        }
        
        // Calculate the new position for the source shape
        const newPosition = alignToReference(
          { x: sourceBounds.x, y: sourceBounds.y, w: sourceBounds.w, h: sourceBounds.h },
          { x: targetBounds.x, y: targetBounds.y, w: targetBounds.w, h: targetBounds.h },
          sourcePoint,
          targetPoint
        );
        
        // Move the source shape to the aligned position using updateShape
        const sourceShapeForUpdate = editor.getShape(sourceShapeId as TLShapeId);
        if (sourceShapeForUpdate) {
          editor.updateShape({
            id: sourceShapeId as TLShapeId,
            x: newPosition.x,
            y: newPosition.y,
          } as Parameters<typeof editor.updateShape>[0]);
        }
        
        console.log("Aligned shapes:", {
          sourceShapeId,
          targetShapeId,
          sourcePoint,
          targetPoint,
          newPosition,
        });
        break;
      }
      default:
        console.warn("Unsupported board command", command);
    }
  } catch (error) {
    const result: CommandResult = {
      success: false,
      commandId,
      error: {
        code: "RENDER_FAILED",
        message: error instanceof Error ? error.message : "Unknown error occurred",
        details: error,
      },
    };
    logCommand(command, result);
    console.error("Error applying board command:", error, command);
    return result;
  }

  // Command executed successfully
  const result: CommandResult = {
    success: true,
    commandId,
    shapeIds: createdShapeIds.length > 0 ? createdShapeIds : undefined,
  };
  logCommand(command, result);
  return result;
}

function mapPagePointToVideo(
  pagePoint: { x: number; y: number },
  pageBounds: PageRect,
  padding: number,
  targetRect: { x: number; y: number; w: number; h: number }
): { x: number; y: number } {
  const exportW = Math.max(pageBounds.w + padding * 2, 1);
  const exportH = Math.max(pageBounds.h + padding * 2, 1);
  const px = (pagePoint.x - pageBounds.x + padding) * (targetRect.w / exportW);
  const py = (pagePoint.y - pageBounds.y + padding) * (targetRect.h / exportH);
  return {
    x: targetRect.x + px,
    y: targetRect.y + py,
  };
}

function CanvasVideoPublisher({
  isConnected,
  editor,
}: {
  isConnected: boolean;
  editor: Editor | null;
}) {
  const room = useRoomContext();
  const timerRef = useRef<number | null>(null);
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null);

  useEffect(() => {
    if (!isConnected || !editor) return;

    let cancelled = false;

    const offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = 1280;
    offscreenCanvas.height = 720;
    const drawCtx = offscreenCanvas.getContext("2d");

    if (!drawCtx) {
      console.error("Unable to create offscreen canvas context for board video");
      return;
    }

    drawCtx.fillStyle = "#0b1220";
    drawCtx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

    const stream = offscreenCanvas.captureStream(2);
    const mediaTrack = stream.getVideoTracks()[0];

    if (!mediaTrack) {
      console.error("No media track produced from board capture stream");
      return;
    }

    const localVideoTrack = new LocalVideoTrack(mediaTrack);
    localVideoTrackRef.current = localVideoTrack;

    void room.localParticipant
      .publishTrack(localVideoTrack, {
        source: Track.Source.Camera,
        simulcast: false,
      })
      .then(() => {
        console.log("Published live board video track");
      })
      .catch((error) => {
        console.error("Failed to publish board video track", error);
      });

    const renderBoardFrame = async () => {
      try {
        const pageShapeIds = [...editor.getCurrentPageShapeIds()];
        const exportPadding = 64;
        const imageResult = await editor.toImage(pageShapeIds, {
          format: "png",
          background: true,
          preserveAspectRatio: "contain",
          padding: exportPadding,
          scale: 1,
        });

        if (cancelled) return;

        const bitmap = await createImageBitmap(imageResult.blob);
        drawCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
        drawCtx.fillStyle = "#0b1220";
        drawCtx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

        const scale = Math.min(
          offscreenCanvas.width / bitmap.width,
          offscreenCanvas.height / bitmap.height
        );
        const targetW = bitmap.width * scale;
        const targetH = bitmap.height * scale;
        const targetX = (offscreenCanvas.width - targetW) / 2;
        const targetY = (offscreenCanvas.height - targetH) / 2;

        drawCtx.drawImage(bitmap, targetX, targetY, targetW, targetH);

        const pageBounds = editor.getCurrentPageBounds();
        if (pageBounds) {
          const normalizedBounds: PageRect = {
            x: pageBounds.x,
            y: pageBounds.y,
            w: pageBounds.w,
            h: pageBounds.h,
          };

          const targetRect = { x: targetX, y: targetY, w: targetW, h: targetH };

          const selection = editor.getSelectionPageBounds();
          if (selection) {
            const topLeft = mapPagePointToVideo(
              { x: selection.x, y: selection.y },
              normalizedBounds,
              exportPadding,
              targetRect
            );
            const bottomRight = mapPagePointToVideo(
              { x: selection.x + selection.w, y: selection.y + selection.h },
              normalizedBounds,
              exportPadding,
              targetRect
            );

            drawCtx.save();
            drawCtx.strokeStyle = "#22d3ee";
            drawCtx.lineWidth = 3;
            drawCtx.setLineDash([10, 6]);
            drawCtx.strokeRect(
              topLeft.x,
              topLeft.y,
              Math.max(1, bottomRight.x - topLeft.x),
              Math.max(1, bottomRight.y - topLeft.y)
            );
            drawCtx.restore();
          }

          const pointer = editor.inputs.getCurrentPagePoint();
          const pointerVideo = mapPagePointToVideo(
            { x: pointer.x, y: pointer.y },
            normalizedBounds,
            exportPadding,
            targetRect
          );

          drawCtx.save();
          drawCtx.fillStyle = "#f97316";
          drawCtx.beginPath();
          drawCtx.arc(pointerVideo.x, pointerVideo.y, 7, 0, Math.PI * 2);
          drawCtx.fill();
          drawCtx.strokeStyle = "#fff";
          drawCtx.lineWidth = 2;
          drawCtx.stroke();
          drawCtx.restore();
        }

        bitmap.close();
      } catch (error) {
        console.error("Failed to render board video frame", error);
      }
    };

    void renderBoardFrame();
    timerRef.current = window.setInterval(() => {
      void renderBoardFrame();
    }, 200);

    return () => {
      cancelled = true;

      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }

      const localTrack = localVideoTrackRef.current;
      localVideoTrackRef.current = null;

      if (localTrack) {
        void room.localParticipant.unpublishTrack(localTrack);
        localTrack.stop();
      }

      stream.getTracks().forEach((track) => track.stop());
    };
  }, [editor, isConnected, room]);

  return null; // This component has no UI
}

function BoardCommandBridge({
  isConnected,
  editor,
  targetStateRef,
  boardStateRef,
}: {
  isConnected: boolean;
  editor: Editor | null;
  targetStateRef: { current: BoardTargetState };
  boardStateRef: { current: BoardState };
}) {
  const room = useRoomContext();

  useEffect(() => {
    if (!isConnected || !editor) return;

    const onDataReceived = (
      payload: Uint8Array,
      _participant?: unknown,
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== "board.command") return;

      try {
        const command = JSON.parse(
          new TextDecoder().decode(payload)
        ) as BoardCommand;
        console.log("[BoardCommandBridge] Received command:", command.op, command);
        applyBoardCommand(editor, command, targetStateRef.current, boardStateRef.current);
      } catch (error) {
        console.error("Failed to apply board command", error);
      }
    };

    room.on("dataReceived", onDataReceived);
    return () => {
      room.off("dataReceived", onDataReceived);
    };
  }, [editor, isConnected, room, targetStateRef]);

  return null;
}

export function TabloWorkspace() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const targetStateRef = useRef<BoardTargetState>({
    lastPointerPagePoint: null,
    pointerShapeId: null,
    thisShapeId: null,
    thatShapeId: null,
  });
  const boardStateRef = useRef<BoardState>(createBoardState());
  const [session, setSession] = useState<SessionBootstrap | null>(null);
  const [boardMetrics, setBoardMetrics] = useState<BoardMetrics>(() =>
    getBoardMetrics(null)
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [realtimeConfig, setRealtimeConfig] = useState<RealtimeConfig | null>(
    null
  );
  const [roomState, setRoomState] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");
  const [roomDetails, setRoomDetails] = useState<{
    roomName: string;
    participantIdentity: string;
    serverUrl?: string;
    token?: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function bootstrapSession() {
      setStatus("loading");
      setErrorMessage("");

      try {
        const [healthRes, sessionRes, realtimeRes] = await Promise.all([
          fetch(`${API_BASE_URL}/health`),
          fetch(`${API_BASE_URL}/session/bootstrap`),
          fetch(`${API_BASE_URL}/realtime/config`),
        ]);

        if (!healthRes.ok) {
          throw new Error(`Health check failed with status ${healthRes.status}`);
        }

        if (!sessionRes.ok) {
          throw new Error(
            `Session bootstrap failed with status ${sessionRes.status}`
          );
        }

        if (!realtimeRes.ok) {
          throw new Error(
            `Realtime config failed with status ${realtimeRes.status}`
          );
        }

        const sessionData = (await sessionRes.json()) as SessionBootstrap;
        const realtimeData = (await realtimeRes.json()) as RealtimeConfig;

        if (!cancelled) {
          setSession(sessionData);
          setRealtimeConfig(realtimeData);
          setStatus("ready");
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Something went wrong while connecting to the backend."
          );
        }
      }
    }

    void bootstrapSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!editor) {
      setBoardMetrics(getBoardMetrics(null));
      return;
    }

    setBoardMetrics(getBoardMetrics(editor));

    const removeListener = editor.store.listen(
      () => {
        setBoardMetrics(getBoardMetrics(editor));
        // Update board state
        updateBoardState(editor, boardStateRef.current);
        // The Gemini model now sees the board through published PNG snapshots.
      },
      { source: "user", scope: "document" }
    );

    return () => {
      removeListener();
    };
  }, [editor, session]);

  useEffect(() => {
    if (!editor) return;

    const targetState = targetStateRef.current;
    const boardState = boardStateRef.current;

    const updateFromSelection = () => {
      const selected = editor.getSelectedShapeIds();
      if (selected.length > 0) {
        updateAllFocusHistory(targetState, boardState, selected[0] ?? null);
      }
    };

    const removeSelectionListener = editor.store.listen(
      () => {
        updateFromSelection();
      },
      { source: "user", scope: "document" }
    );

    updateFromSelection();

    const interval = window.setInterval(() => {
      const pointer = editor.inputs.getCurrentPagePoint();
      targetState.lastPointerPagePoint = { x: pointer.x, y: pointer.y };

      const hoverShape = editor.getShapeAtPoint(pointer, {
        hitInside: true,
        hitLabels: true,
        renderingOnly: true,
      });

      const hoverId = hoverShape?.id ?? null;
      targetState.pointerShapeId = hoverId;
      updateAllFocusHistory(targetState, boardState, hoverId);
    }, 120);

    return () => {
      removeSelectionListener();
      window.clearInterval(interval);
    };
  }, [editor]);

  async function connectLiveKit() {
    if (!session || !realtimeConfig?.configured) {
      setErrorMessage(
        "LiveKit is not configured yet. Add LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to the backend."
      );
      return;
    }

    setRoomState("connecting");
    setErrorMessage("");

    try {
      const tokenRes = await fetch(`${API_BASE_URL}/livekit/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: session.session_id,
        }),
      });

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        throw new Error(
          `LiveKit token request failed with status ${tokenRes.status}: ${errorText}`
        );
      }

      const tokenData = (await tokenRes.json()) as LiveKitTokenResponse;

      setRoomDetails({
        roomName: tokenData.room_name,
        participantIdentity: tokenData.participant_identity,
        serverUrl: tokenData.server_url,
        token: tokenData.token,
      });
    } catch (error) {
      setRoomState("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while connecting to LiveKit."
      );
    }
  }

  function disconnectLiveKit() {
    setRoomDetails(null);
    setRoomState("idle");
  }

  return (
    <LiveKitRoom
      serverUrl={roomDetails?.serverUrl}
      token={roomDetails?.token}
      connect={!!roomDetails}
      audio={true}
      onConnected={() => setRoomState("connected")}
      onDisconnected={() => {
        setRoomState("idle");
        setRoomDetails(null);
      }}
    >
      <RoomAudioRenderer />
      <CanvasVideoPublisher isConnected={roomState === "connected"} editor={editor} />
      <BoardCommandBridge
        isConnected={roomState === "connected"}
        editor={editor}
        targetStateRef={targetStateRef}
        boardStateRef={boardStateRef}
      />
      <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.2),_transparent_30%),linear-gradient(180deg,_#113c66_0%,_#0a1d2f_50%,_#07111a_100%)] text-slate-50">
        <div className="relative flex min-h-screen flex-col">

        <section className="flex min-h-screen flex-1">
          <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0">
              <Tldraw onMount={setEditor} autoFocus />
            </div>
          </div>

          <aside className="hidden w-[380px] shrink-0 border-l border-white/10 bg-slate-950/62 p-4 backdrop-blur xl:flex xl:flex-col">
            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/70">
                Realtime status
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                This shell is now aligned with the actual product direction:
                LiveKit for room transport, backend-issued tokens, and live
                vision input before Gemini Live.
              </p>
            </div>

            <div className="mt-4 rounded-[24px] border border-white/10 bg-slate-900/75 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                Session readiness
              </p>

              {status === "error" ? (
                <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm leading-6 text-rose-100">
                  {errorMessage}
                </div>
              ) : null}

              {session ? (
                <div className="mt-4 space-y-4 text-sm leading-6 text-slate-200">
                  <div>
                    <p className="font-medium text-white">Session ID</p>
                    <p className="mt-1">{session.session_id}</p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Backend status</p>
                    <p className="mt-1">{session.backend_status}</p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Vision feed</p>
                    <p className="mt-1">
                      The board is streamed as a live video track into the room
                      so Gemini receives ongoing visual context.
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Live board metrics</p>
                    <p className="mt-1">{boardMetrics.summary}</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-4 rounded-[24px] border border-white/10 bg-slate-900/75 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                LiveKit setup
              </p>
              {realtimeConfig ? (
                <div className="mt-4 space-y-4 text-sm leading-6 text-slate-200">
                  <div>
                    <p className="font-medium text-white">Configured</p>
                    <p className="mt-1">
                      {realtimeConfig.configured
                        ? `Yes${realtimeConfig.livekit_url ? `, ${realtimeConfig.livekit_url}` : ""}`
                        : "No. Add backend LiveKit credentials to enable room connection."}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Audio pipeline</p>
                    <p className="mt-1">
                      LiveKit transport: {realtimeConfig.livekit_audio_hz} Hz
                      → Gemini input: {realtimeConfig.gemini_input_hz} Hz →
                      Gemini output: {realtimeConfig.gemini_output_hz} Hz →
                      back to LiveKit.
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Conversion boundary</p>
                    <p className="mt-1">
                      {realtimeConfig.backend_conversion_boundary}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-white">Notes</p>
                    <ul className="mt-2 list-disc space-y-2 pl-5 text-slate-300">
                      {realtimeConfig.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex-1 rounded-[24px] border border-white/10 bg-slate-900/75 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                Room connection
              </p>
              <div className="mt-4 space-y-4 text-sm leading-6 text-slate-200">
                <div>
                  <p className="font-medium text-white">State</p>
                  <p className="mt-1">
                    {roomState === "connected"
                      ? "Connected to LiveKit room."
                      : roomState === "connecting"
                        ? "Connecting to LiveKit..."
                        : roomState === "error"
                          ? "LiveKit connection failed."
                          : "Not connected yet."}
                  </p>
                </div>
                {roomDetails ? (
                  <>
                    <div>
                      <p className="font-medium text-white">Room</p>
                      <p className="mt-1">{roomDetails.roomName}</p>
                    </div>
                    <div>
                      <p className="font-medium text-white">Participant</p>
                      <p className="mt-1">{roomDetails.participantIdentity}</p>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </aside>
        </section>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4 md:px-6 md:pb-6">
          <div className="pointer-events-auto mx-auto max-w-xl rounded-[30px] border border-white/10 bg-slate-950/70 px-4 py-3 shadow-[0_24px_80px_rgba(3,8,20,0.45)] backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-slate-300">
                {boardMetrics.summary}
              </div>
              {roomState === "connected" ? (
                <div className="flex items-center gap-3" data-lk-theme="default">
                  <VoiceAssistantControlBar />
                  <button
                    className="rounded-full border border-rose-300/30 bg-rose-400/10 px-4 py-2 text-sm font-semibold text-rose-100"
                    onClick={disconnectLiveKit}
                    type="button"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    roomState === "connecting" || !realtimeConfig?.configured
                  }
                  onClick={connectLiveKit}
                  type="button"
                >
                  {roomState === "connecting" ? "Connecting..." : "Connect LiveKit"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
    </LiveKitRoom>
  );
}
