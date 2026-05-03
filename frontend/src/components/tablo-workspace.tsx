/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, prefer-const */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tldraw, type Editor, type TLShapeId, b64Vecs, createShapeId, getSnapshot, loadSnapshot } from "tldraw";
import { svgShapeUtils } from "./SvgShape";
import { toRichText } from "@tldraw/tlschema";
import { LiveKitRoom, RoomAudioRenderer, VoiceAssistantControlBar, useRoomContext } from "@livekit/components-react";
import { create as createMathScope, evaluate as mathEvaluate } from "mathjs";
import "@livekit/components-styles";
import { SourcePanel, type SourceAttribution, type SourcesPayload } from "./source-panel";
import { DocumentUploadButton } from "./document-upload";
import { DocumentViewerPanel, type DocumentMeta, type NavigationTarget, type LearnerSelection } from "./document-viewer-panel";

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

// 3D shape edge/face labeling structure (used by create_3d_* commands)
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
      
    case "create_svg": {
      if (!cmd.svg || typeof cmd.svg !== "string") {
        return { 
          valid: false, 
          error: { 
            code: "VALIDATION_FAILED", 
            message: "SVG content must be a non-empty string",
            details: { svg: cmd.svg }
          } 
        };
      }
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

    case "create_graph": {
      if (!cmd.expressions || !Array.isArray(cmd.expressions) || cmd.expressions.length === 0) {
        return {
          valid: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "expressions must be a non-empty array",
            details: { expressions: cmd.expressions },
          },
        };
      }
      break;
    }

    case "update_shape": {
      if (!cmd.shapeId || typeof cmd.shapeId !== "string") {
        return {
          valid: false,
          error: { code: "VALIDATION_FAILED", message: "shapeId must be a non-empty string", details: { shapeId: cmd.shapeId } },
        };
      }
      break;
    }

    case "delete_shape": {
      if (!cmd.shapeId || typeof cmd.shapeId !== "string") {
        return {
          valid: false,
          error: { code: "VALIDATION_FAILED", message: "shapeId must be a non-empty string", details: { shapeId: cmd.shapeId } },
        };
      }
      break;
    }

    case "undo":
      break;

    case "create_polygon": {
      if (!cmd.sides || cmd.sides < 3) {
        return { valid: false, error: { code: "VALIDATION_FAILED", message: "sides must be >= 3", details: {} } };
      }
      break;
    }

    case "create_parametric_graph": {
      if (!cmd.exprX || !cmd.exprY) {
        return { valid: false, error: { code: "VALIDATION_FAILED", message: "exprX and exprY are required", details: {} } };
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
  // SVG Shape Command - AI generates SVG code directly
  | {
      v: number;
      id: string;
      op: "create_svg";
      svg: string;
      x: number;
      y: number;
      w?: number;
      h?: number;
      color?: string;
    }
  // Math Graph Command - frontend evaluates expressions accurately
  | {
      v: number;
      id: string;
      op: "create_graph";
      expressions: Array<{
        expr: string;       // e.g. "tan(x)", "x^2", "sin(x)/x"
        color?: string;     // line color, defaults to a palette
        label?: string;     // legend label
      }>;
      x: number;            // board position
      y: number;
      w?: number;           // canvas width in px, default 400
      h?: number;           // canvas height in px, default 300
      xMin?: number;        // x-axis range, default -2*pi
      xMax?: number;        // x-axis range, default 2*pi
      yMin?: number;        // y-axis range, auto if omitted
      yMax?: number;
      title?: string;
    }
  // Parametric Graph Command
  | {
      v: number;
      id: string;
      op: "create_parametric_graph";
      exprX: string;        // x = f(t), e.g. "cos(t)"
      exprY: string;        // y = g(t), e.g. "sin(t)"
      tMin?: number;        // parameter range, default 0
      tMax?: number;        // parameter range, default 2*pi
      x: number;
      y: number;
      w?: number;
      h?: number;
      color?: string;
      label?: string;
      title?: string;
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
    }
  // Update existing shape — modify props without recreating
  | {
      v: number;
      id: string;
      op: "update_shape";
      shapeId: string;           // ID from get_board_state
      label?: string;            // update text label on geo/text shapes
      color?: string;            // update stroke color
      x?: number;                // move to new position
      y?: number;
      w?: number;                // resize
      h?: number;
    }
  // Delete specific shapes by ID
  | {
      v: number;
      id: string;
      op: "delete_shape";
      shapeId: string;
    }
  // Undo last action
  | {
      v: number;
      id: string;
      op: "undo";
    }
  // Regular polygon by math (pentagon, hexagon, star, etc.)
  | {
      v: number;
      id: string;
      op: "create_polygon";
      sides: number;          // 3=triangle, 5=pentagon, 6=hexagon, etc.
      x: number;              // center x
      y: number;              // center y
      radius: number;         // circumradius in px
      rotation?: number;      // rotation in degrees, default 0
      star?: boolean;         // if true, draw a star (inner radius = radius/2.5)
      label?: string;
    }
  // ─── 3D Shapes (isometric projection) ────────────────────────────────────
  | { v: number; id: string; op: "create_3d_cube";     x: number; y: number; size: number;  label?: string; edgeLabels?: string[] }
  | { v: number; id: string; op: "create_3d_prism";    x: number; y: number; width: number; height: number; depth: number; triangular?: boolean; label?: string }
  | { v: number; id: string; op: "create_3d_cylinder"; x: number; y: number; radius: number; height: number; label?: string }
  | { v: number; id: string; op: "create_3d_cone";     x: number; y: number; radius: number; height: number; label?: string }
  | { v: number; id: string; op: "create_3d_pyramid";  x: number; y: number; baseSize: number; height: number; label?: string };

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
function getShapeType(shape: { type: string }): ShapeType {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  lastBoardStateResponse: string | null;
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

// ============================================
// Math Graph Renderer
// Evaluates expressions accurately using mathjs,
// then builds an SVG string for the SvgShape.
// ============================================

const GRAPH_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];

interface GraphExpression {
  expr: string;
  color?: string;
  label?: string;
}

function buildGraphSvg(
  expressions: GraphExpression[],
  xMin: number,
  xMax: number,
  yMin: number | undefined,
  yMax: number | undefined,
  svgW: number,
  svgH: number,
  title?: string
): string {
  const PADDING = { top: title ? 36 : 20, right: 20, bottom: 36, left: 44 };
  const plotW = svgW - PADDING.left - PADDING.right;
  const plotH = svgH - PADDING.top - PADDING.bottom;
  const STEPS = 600;

  // Evaluate all expressions to find y range
  const allPoints: Array<Array<{ x: number; y: number } | null>> = [];

  for (const { expr } of expressions) {
    const pts: Array<{ x: number; y: number } | null> = [];
    for (let i = 0; i <= STEPS; i++) {
      const xVal = xMin + (i / STEPS) * (xMax - xMin);
      try {
        const yVal = mathEvaluate(expr, { x: xVal, pi: Math.PI, e: Math.E, ln: Math.log });
        if (typeof yVal === "number" && isFinite(yVal)) {
          pts.push({ x: xVal, y: yVal });
        } else {
          pts.push(null); // asymptote / undefined
        }
      } catch {
        pts.push(null);
      }
    }
    allPoints.push(pts);
  }

  // Auto y range if not provided
  let computedYMin = yMin;
  let computedYMax = yMax;
  if (computedYMin === undefined || computedYMax === undefined) {
    const allY = allPoints.flat().filter(Boolean).map((p) => p!.y);
    if (allY.length === 0) {
      computedYMin = -10;
      computedYMax = 10;
    } else {
      const rawMin = Math.min(...allY);
      const rawMax = Math.max(...allY);
      const range = rawMax - rawMin || 1;
      // Clamp extreme ranges (e.g. tan asymptotes)
      const clampedMin = Math.max(rawMin, -50);
      const clampedMax = Math.min(rawMax, 50);
      const pad = (clampedMax - clampedMin) * 0.1 || 1;
      computedYMin = computedYMin ?? clampedMin - pad;
      computedYMax = computedYMax ?? clampedMax + pad;
    }
  }

  const yRange = computedYMax - computedYMin || 1;
  const xRange = xMax - xMin;

  // Map math coords to SVG coords
  const toSvgX = (x: number) => PADDING.left + ((x - xMin) / xRange) * plotW;
  const toSvgY = (y: number) => PADDING.top + ((computedYMax! - y) / yRange) * plotH;

  // Build axis lines
  const axisY = toSvgY(0);
  const axisX = toSvgX(0);
  const clampedAxisY = Math.max(PADDING.top, Math.min(PADDING.top + plotH, axisY));
  const clampedAxisX = Math.max(PADDING.left, Math.min(PADDING.left + plotW, axisX));

  let svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${svgW} ${svgH}'>`;
  svg += `<rect width='${svgW}' height='${svgH}' fill='white' rx='4'/>`;

  // Title
  if (title) {
    svg += `<text x='${svgW / 2}' y='18' text-anchor='middle' font-size='13' font-family='sans-serif' font-weight='bold' fill='#1e293b'>${title}</text>`;
  }

  // Grid lines (light)
  const xTicks = 8;
  const yTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const xv = xMin + (i / xTicks) * xRange;
    const sx = toSvgX(xv);
    svg += `<line x1='${sx}' y1='${PADDING.top}' x2='${sx}' y2='${PADDING.top + plotH}' stroke='#e2e8f0' stroke-width='1'/>`;
    const label = Number.isInteger(xv) ? xv.toString() : xv.toFixed(1);
    svg += `<text x='${sx}' y='${PADDING.top + plotH + 14}' text-anchor='middle' font-size='9' font-family='sans-serif' fill='#64748b'>${label}</text>`;
  }
  for (let i = 0; i <= yTicks; i++) {
    const yv = computedYMin! + (i / yTicks) * yRange;
    const sy = toSvgY(yv);
    svg += `<line x1='${PADDING.left}' y1='${sy}' x2='${PADDING.left + plotW}' y2='${sy}' stroke='#e2e8f0' stroke-width='1'/>`;
    const label = Number.isInteger(yv) ? yv.toString() : yv.toFixed(1);
    svg += `<text x='${PADDING.left - 4}' y='${sy + 4}' text-anchor='end' font-size='9' font-family='sans-serif' fill='#64748b'>${label}</text>`;
  }

  // Axes
  svg += `<line x1='${PADDING.left}' y1='${clampedAxisY}' x2='${PADDING.left + plotW}' y2='${clampedAxisY}' stroke='#334155' stroke-width='1.5'/>`;
  svg += `<line x1='${clampedAxisX}' y1='${PADDING.top}' x2='${clampedAxisX}' y2='${PADDING.top + plotH}' stroke='#334155' stroke-width='1.5'/>`;
  // Axis arrows
  svg += `<polygon points='${PADDING.left + plotW},${clampedAxisY - 4} ${PADDING.left + plotW + 8},${clampedAxisY} ${PADDING.left + plotW},${clampedAxisY + 4}' fill='#334155'/>`;
  svg += `<polygon points='${clampedAxisX - 4},${PADDING.top} ${clampedAxisX},${PADDING.top - 8} ${clampedAxisX + 4},${PADDING.top}' fill='#334155'/>`;
  // Axis labels
  svg += `<text x='${PADDING.left + plotW + 10}' y='${clampedAxisY + 4}' font-size='11' font-family='sans-serif' fill='#334155'>x</text>`;
  svg += `<text x='${clampedAxisX + 4}' y='${PADDING.top - 10}' font-size='11' font-family='sans-serif' fill='#334155'>y</text>`;

  // Plot each expression as a path, breaking at asymptotes (null points)
  for (let ei = 0; ei < allPoints.length; ei++) {
    const pts = allPoints[ei];
    const color = expressions[ei].color ?? GRAPH_COLORS[ei % GRAPH_COLORS.length];
    let pathD = "";
    let inSegment = false;

    for (const pt of pts) {
      if (pt === null) {
        inSegment = false;
        continue;
      }
      const sx = toSvgX(pt.x);
      const sy = toSvgY(pt.y);
      // Skip points outside the plot area (clamp check)
      if (sy < PADDING.top - 2 || sy > PADDING.top + plotH + 2) {
        inSegment = false;
        continue;
      }
      if (!inSegment) {
        pathD += `M ${sx.toFixed(1)} ${sy.toFixed(1)} `;
        inSegment = true;
      } else {
        pathD += `L ${sx.toFixed(1)} ${sy.toFixed(1)} `;
      }
    }

    if (pathD) {
      svg += `<path d='${pathD}' fill='none' stroke='${color}' stroke-width='2' stroke-linejoin='round' stroke-linecap='round'/>`;
    }
  }

  // Legend
  const legendExpressions = expressions.filter((e) => e.label || e.expr);
  if (legendExpressions.length > 1) {
    const legendX = PADDING.left + 8;
    let legendY = PADDING.top + 12;
    for (let ei = 0; ei < legendExpressions.length; ei++) {
      const color = legendExpressions[ei].color ?? GRAPH_COLORS[ei % GRAPH_COLORS.length];
      const label = legendExpressions[ei].label ?? legendExpressions[ei].expr;
      svg += `<line x1='${legendX}' y1='${legendY}' x2='${legendX + 16}' y2='${legendY}' stroke='${color}' stroke-width='2'/>`;
      svg += `<text x='${legendX + 20}' y='${legendY + 4}' font-size='10' font-family='sans-serif' fill='#1e293b'>${label}</text>`;
      legendY += 16;
    }
  }

  svg += `</svg>`;
  return svg;
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
        const rawText = command.text;
        if (!rawText || typeof rawText !== "string") {
          console.warn("[create_text] Skipping — text is missing or not a string", command);
          break;
        }

        // Use agent coordinates if valid, otherwise viewport center
        const vpText = editor.getViewportPageBounds();
        const textX = Number.isFinite(command.x) ? command.x : vpText.x + vpText.w / 2 - 50;
        const textY = Number.isFinite(command.y) ? command.y : vpText.y + vpText.h / 2;

        const fontSizeNum = typeof command.fontSize === "number" && Number.isFinite(command.fontSize)
          ? command.fontSize : 24;
        const textSize = fontSizeNum <= 14 ? "s" : fontSizeNum <= 24 ? "m" : fontSizeNum <= 36 ? "l" : "xl";

        const textColor = command.color && typeof command.color === "string" 
          ? command.color 
          : undefined;

        editor.createShape({
          type: "text",
          x: textX,
          y: textY,
          props: {
            richText: toRichText(rawText),
            size: textSize,
            ...(textColor && { color: textColor }),
          },
        } as unknown as CreateShapeInput);
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

        // Get font size with default — map to tldraw size enum
        const fontSizeRaw = typeof fontSize === "number" && Number.isFinite(fontSize) ? fontSize : 24;
        const mlSize = fontSizeRaw <= 14 ? "s" : fontSizeRaw <= 24 ? "m" : fontSizeRaw <= 36 ? "l" : "xl";

        // Get color with default
        const textColor = color && typeof color === "string" ? color : "black";

        // Get line spacing (default 1.2x font size)
        const spacing = typeof lineSpacing === "number" && Number.isFinite(lineSpacing)
          ? lineSpacing
          : fontSizeRaw * 1.2;

        // Get alignment (default left)
        const align = alignment ?? "left";

        // Estimate character width for alignment (approximate)
        const charWidth = fontSizeRaw * 0.6;

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
              size: mlSize,
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

        // Get font size with default — map to tldraw size enum
        const fSizeNum = typeof fontSize === "number" && Number.isFinite(fontSize) ? fontSize : 24;
        const formulaSize = fSizeNum <= 14 ? "s" : fSizeNum <= 24 ? "m" : fSizeNum <= 36 ? "l" : "xl";

        // Get color with default
        const textColor = color && typeof color === "string" ? color : "black";

        const formulaShapeId = editor.createShape({
          type: "text",
          x: x,
          y: y,
          props: {
            richText: toRichText(parsedFormula),
            color: textColor,
            size: formulaSize,
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

        // Convert all geo shapes to SVG for consistent rendering
        const geoType = (command.geo || "rectangle").toLowerCase();
        const gw = Math.max(command.w, 40);
        const gh = Math.max(command.h, 40);
        const label = command.label ?? "";

        // Generate SVG content based on geo type
        let geoSvg = "";
        const stroke = "stroke='black' stroke-width='2' fill='none'";
        switch (geoType) {
          case "rectangle":
          case "box":
          case "square":
            geoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}"><rect x="2" y="2" width="${gw - 4}" height="${gh - 4}" fill="none" stroke="black" stroke-width="2"/>${label ? `<text x="${gw / 2}" y="${gh / 2 + 5}" text-anchor="middle" font-size="14" fill="black">${label}</text>` : ""}</svg>`;
            break;
          case "ellipse":
          case "circle":
            geoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}"><ellipse cx="${gw / 2}" cy="${gh / 2}" rx="${gw / 2 - 2}" ry="${gh / 2 - 2}" fill="none" stroke="black" stroke-width="2"/>${label ? `<text x="${gw / 2}" y="${gh / 2 + 5}" text-anchor="middle" font-size="14" fill="black">${label}</text>` : ""}</svg>`;
            break;
          case "triangle":
          case "right_triangle":
          case "righttriangle":
            geoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}"><polygon points="${gw / 2},2 ${gw - 2},${gh - 2} 2,${gh - 2}" fill="none" stroke="black" stroke-width="2"/>${label ? `<text x="${gw / 2}" y="${gh / 2 + 5}" text-anchor="middle" font-size="14" fill="black">${label}</text>` : ""}</svg>`;
            break;
          case "diamond":
            geoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}"><polygon points="${gw / 2},2 ${gw - 2},${gh / 2} ${gw / 2},${gh - 2} 2,${gh / 2}" fill="none" stroke="black" stroke-width="2"/>${label ? `<text x="${gw / 2}" y="${gh / 2 + 5}" text-anchor="middle" font-size="14" fill="black">${label}</text>` : ""}</svg>`;
            break;
          default:
            geoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}"><rect x="2" y="2" width="${gw - 4}" height="${gh - 4}" fill="none" stroke="black" stroke-width="2"/>${label ? `<text x="${gw / 2}" y="${gh / 2 + 5}" text-anchor="middle" font-size="14" fill="black">${label}</text>` : ""}</svg>`;
            break;
        }

        // Place in viewport center
        const vpGeo = editor.getViewportPageBounds();
        let geoX = command.x;
        let geoY = command.y;
        if (geoX < vpGeo.x || geoX > vpGeo.x + vpGeo.w || geoY < vpGeo.y || geoY > vpGeo.y + vpGeo.h) {
          geoX = vpGeo.x + vpGeo.w / 2 - gw / 2;
          geoY = vpGeo.y + vpGeo.h / 2 - gh / 2;
        }

        editor.createShape({
          type: "svg_shape",
          x: geoX,
          y: geoY,
          props: { w: gw, h: gh, svg: geoSvg, color: "#1e293b" },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        console.log("[create_geo→svg]", geoType, "at", geoX, geoY);
        break;
      }
      case "create_arrow": {
        // Default to viewport center if coordinates are missing
        const vpa = editor.getViewportPageBounds();
        const ax = Number.isFinite(command.x) ? command.x : vpa.x + vpa.w * 0.3;
        const ay = Number.isFinite(command.y) ? command.y : vpa.y + vpa.h / 2;
        const atx = Number.isFinite(command.toX) ? command.toX : vpa.x + vpa.w * 0.7;
        const aty = Number.isFinite(command.toY) ? command.toY : vpa.y + vpa.h / 2;
        const dx = atx - ax;
        const dy = aty - ay;

        editor.createShape({
          type: "arrow",
          x: ax,
          y: ay,
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
        if (!command.points || command.points.length < 2) {
          console.warn("Skipping create_freehand, need at least 2 points", command);
          break;
        }

        const fhPoints = command.points.map((p) => ({ x: p.x, y: p.y, z: 0.5 }));
        const ox = fhPoints[0].x;
        const oy = fhPoints[0].y;
        const relPoints = fhPoints.map((p) => ({ x: p.x - ox, y: p.y - oy, z: 0.5 }));
        const color = command.color ?? "black";

        editor.createShape({
          type: "draw",
          x: ox,
          y: oy,
          props: {
            segments: [{ type: "free", path: b64Vecs.encodePoints(relPoints) }],
            color: color,
            size: "s",
            dash: "draw",
            isComplete: true,
            isClosed: false,
            isPen: false,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        break;
      }
      case "create_freehand_stroke": {
        if (!command.points || command.points.length < 2) {
          console.warn("Skipping create_freehand_stroke, need at least 2 points", command);
          break;
        }

        const fhsPoints = command.points.map((p) => ({ x: p.x, y: p.y, z: 0.5 }));
        const ox2 = fhsPoints[0].x;
        const oy2 = fhsPoints[0].y;
        const relPoints2 = fhsPoints.map((p) => ({ x: p.x - ox2, y: p.y - oy2, z: 0.5 }));

        editor.createShape({
          type: "draw",
          x: ox2,
          y: oy2,
          props: {
            segments: [{ type: "free", path: b64Vecs.encodePoints(relPoints2) }],
            color: command.color,
            size: "s",
            dash: "draw",
            isComplete: true,
            isClosed: false,
            isPen: false,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
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
      // SVG Shape Command - AI generates SVG code directly
      // ============================================
      case "create_svg": {
        const { svg, color } = command;
        let x: number = (command.x as number) ?? 0;
        let y: number = (command.y as number) ?? 0;
        const w = command.w ?? 200;
        const h = command.h ?? 200;

        // Validate SVG content
        if (!svg || typeof svg !== "string") {
          console.warn("Skipping create_svg, missing SVG content", command);
          break;
        }

        const width = Number.isFinite(w) && w > 0 ? w : 200;
        const height = Number.isFinite(h) && h > 0 ? h : 200;
        const strokeColor = color || "#1e293b";

        // Use agent coordinates if valid, otherwise viewport center
        const vpSvg = editor.getViewportPageBounds();
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          x = vpSvg.x + vpSvg.w / 2 - width / 2;
          y = vpSvg.y + vpSvg.h / 2 - height / 2;
        }

        const svgShapeId = editor.createShape({
          type: "svg_shape",
          x,
          y,
          props: {
            w: width,
            h: height,
            svg: svg,
            color: strokeColor,
          },
        } as unknown as CreateShapeInput);
        createdShapeIds.push("created");
        editor.zoomToFit({ animation: { duration: 300 } });
        console.log("Created SVG shape:", svgShapeId, "at", x, y);
        break;
      }
      // ============================================
      // Math Graph Command - accurate function plotting
      // ============================================
      // Math Graph Command - composable native tldraw shapes
      // Each curve = freehand draw shape (selectable/deletable)
      // Axes = arrows, Labels = text shapes, all grouped
      // ============================================
      case "create_graph": {
        const {
          expressions,
          x: _gx = 0,
          y: _gy = 0,
          w: gw = 400,
          h: gh = 300,
          xMin = -2 * Math.PI,
          xMax = 2 * Math.PI,
          yMin,
          yMax,
          title,
        } = command;
        let gx = _gx;
        let gy = _gy;

        if (!expressions || expressions.length === 0) {
          console.warn("[create_graph] No expressions provided");
          break;
        }

        // If position is 0,0 exactly (agent default), center in viewport
        if (gx === 0 && gy === 0) {
          const vp = editor.getViewportPageBounds();
          gx = vp.x + vp.w / 2 - gw / 2;
          gy = vp.y + vp.h / 2 - gh / 2;
        }

        console.log("[create_graph] Plotting:", expressions.map((e) => e.expr).join(", "));

        const PADDING = { top: title ? 40 : 20, right: 20, bottom: 36, left: 44 };
        const plotW = gw - PADDING.left - PADDING.right;
        const plotH = gh - PADDING.top - PADDING.bottom;
        const STEPS = 300;

        // Evaluate all expressions to find y range
        const allComputedPoints: Array<Array<{ x: number; y: number } | null>> = [];
        for (const { expr } of expressions) {
          const pts: Array<{ x: number; y: number } | null> = [];
          for (let i = 0; i <= STEPS; i++) {
            const xVal = xMin + (i / STEPS) * (xMax - xMin);
            try {
              const yVal = mathEvaluate(expr, { x: xVal, pi: Math.PI, e: Math.E, ln: Math.log });
              pts.push(typeof yVal === "number" && isFinite(yVal) ? { x: xVal, y: yVal } : null);
            } catch { pts.push(null); }
          }
          allComputedPoints.push(pts);
        }

        // Auto y range
        let computedYMin = yMin;
        let computedYMax = yMax;
        if (computedYMin === undefined || computedYMax === undefined) {
          const allY = allComputedPoints.flat().filter(Boolean).map((p) => p!.y);
          if (allY.length === 0) { computedYMin = -10; computedYMax = 10; }
          else {
            const pad = (Math.min(Math.max(...allY), 50) - Math.max(Math.min(...allY), -50)) * 0.1 || 1;
            computedYMin = computedYMin ?? Math.max(Math.min(...allY), -50) - pad;
            computedYMax = computedYMax ?? Math.min(Math.max(...allY), 50) + pad;
          }
        }
        const yRange = (computedYMax! - computedYMin!) || 1;
        const xRange = xMax - xMin;

        const toSvgX = (x: number) => gx + PADDING.left + ((x - xMin) / xRange) * plotW;
        const toSvgY = (y: number) => gy + PADDING.top + ((computedYMax! - y) / yRange) * plotH;

        const graphShapeIds: TLShapeId[] = [];

        // Helper: create shape with pre-generated ID and track it
        const addGraphShape = (shapeData: Record<string, unknown>) => {
          const id = createShapeId();
          editor.createShape({ id, ...shapeData } as any);
          graphShapeIds.push(id);
        };

        // Title text
        if (title) {
          addGraphShape({
            type: "text",
            x: gx + gw / 2 - 60,
            y: gy + 4,
            props: { richText: toRichText(title), size: "s", color: "black" },
          });
        }

        // X axis arrow
        const axisY = Math.max(gy + PADDING.top, Math.min(gy + PADDING.top + plotH, toSvgY(0)));
        const axisX = Math.max(gx + PADDING.left, Math.min(gx + PADDING.left + plotW, toSvgX(0)));
        addGraphShape({
          type: "arrow", x: gx + PADDING.left, y: axisY,
          props: { start: { x: 0, y: 0 }, end: { x: plotW + 12, y: 0 }, richText: toRichText(""), color: "black", size: "s" },
        });

        // Y axis arrow
        addGraphShape({
          type: "arrow", x: axisX, y: gy + PADDING.top + plotH + 12,
          props: { start: { x: 0, y: 0 }, end: { x: 0, y: -(plotH + 24) }, richText: toRichText(""), color: "black", size: "s" },
        });

        // Axis labels
        addGraphShape({ type: "text", x: gx + PADDING.left + plotW + 14, y: axisY - 8, props: { richText: toRichText("x"), size: "s", color: "black" } });
        addGraphShape({ type: "text", x: axisX + 4, y: gy + PADDING.top - 20, props: { richText: toRichText("y"), size: "s", color: "black" } });

        // X tick labels
        const xTicks = 6;
        for (let i = 0; i <= xTicks; i++) {
          const xv = xMin + (i / xTicks) * xRange;
          const sx = toSvgX(xv);
          const label = Math.abs(xv) < 0.01 ? "0" : Number.isInteger(xv) ? xv.toString() : xv.toFixed(1);
          addGraphShape({ type: "text", x: sx - 8, y: axisY + 6, props: { richText: toRichText(label), size: "s", color: "grey" } });
        }

        // Y tick labels
        const yTicks = 5;
        for (let i = 0; i <= yTicks; i++) {
          const yv = computedYMin! + (i / yTicks) * yRange;
          const sy = toSvgY(yv);
          const label = Math.abs(yv) < 0.01 ? "0" : Number.isInteger(yv) ? yv.toString() : yv.toFixed(1);
          addGraphShape({ type: "text", x: gx + PADDING.left - 28, y: sy - 6, props: { richText: toRichText(label), size: "s", color: "grey" } });
        }

        // Plot each expression as a freehand draw shape (native, selectable, deletable)
        // tldraw valid colors: black, grey, light-violet, violet, blue, light-blue, cyan,
        //                      green, light-green, yellow, orange, red, light-red, white
        const CURVE_COLORS = ["blue", "red", "green", "orange", "violet", "cyan"];
        for (let ei = 0; ei < allComputedPoints.length; ei++) {
          const pts = allComputedPoints[ei];
          // Map any hex/css color to nearest tldraw color name
          const rawColor = expressions[ei].color;
          const color = rawColor ?? CURVE_COLORS[ei % CURVE_COLORS.length];

          // Split into segments at asymptotes (null points)
          const segments: Array<Array<{ x: number; y: number }>> = [];
          let current: Array<{ x: number; y: number }> = [];

          for (const pt of pts) {
            if (pt === null) {
              if (current.length >= 2) segments.push(current);
              current = [];
              continue;
            }
            const sy = toSvgY(pt.y);
            // Skip points outside plot area
            if (sy < gy + PADDING.top - 2 || sy > gy + PADDING.top + plotH + 2) {
              if (current.length >= 2) segments.push(current);
              current = [];
              continue;
            }
            current.push({ x: toSvgX(pt.x), y: sy });
          }
          if (current.length >= 2) segments.push(current);

          for (const seg of segments) {
            if (seg.length < 2) continue;
            const ox = seg[0].x;
            const oy = seg[0].y;
            const drawPoints = seg.map((p) => ({ x: p.x - ox, y: p.y - oy, z: 0.5 }));

            addGraphShape({
              type: "draw", x: ox, y: oy,
              props: {
                segments: [{ type: "free", path: b64Vecs.encodePoints(drawPoints) }],
                color: color, size: "s", dash: "solid",
                isComplete: true, isClosed: false, isPen: false, scale: 1, scaleX: 1, scaleY: 1,
              },
            });
          }

          // Legend label if multiple expressions
          if (expressions.length > 1) {
            const legendLabel = expressions[ei].label ?? expressions[ei].expr;
            addGraphShape({ type: "text", x: gx + PADDING.left + 8, y: gy + PADDING.top + 8 + ei * 18, props: { richText: toRichText(legendLabel), size: "s", color: color } });
          }
        }

        // Group all shapes together
        if (graphShapeIds.length > 1) {
          editor.groupShapes(graphShapeIds);
        }

        createdShapeIds.push("created");
        console.log("[create_graph] Created composable graph with", graphShapeIds.length, "shapes");
        break;
      }
      // ============================================
      // Update existing shape — modify without recreating
      // ============================================
      case "update_shape": {
        const { shapeId, label, color, x: ux, y: uy, w: uw, h: uh } = command;
        const existing = editor.getShape(shapeId as TLShapeId);
        if (!existing) {
          console.warn("[update_shape] Shape not found:", shapeId);
          break;
        }

        const propsUpdate: Record<string, unknown> = {};
        if (label !== undefined) propsUpdate.richText = toRichText(label);
        if (color !== undefined) propsUpdate.color = color;
        if (uw !== undefined) propsUpdate.w = uw;
        if (uh !== undefined) propsUpdate.h = uh;

        const posUpdate: Record<string, unknown> = {};
        if (ux !== undefined) posUpdate.x = ux;
        if (uy !== undefined) posUpdate.y = uy;

        editor.updateShape({
          id: shapeId as TLShapeId,
          type: existing.type,
          ...posUpdate,
          props: Object.keys(propsUpdate).length > 0 ? propsUpdate : undefined,
        } as any);

        console.log("[update_shape] Updated shape:", shapeId);
        break;
      }

      // ============================================
      // Delete a specific shape by ID
      // ============================================
      case "delete_shape": {
        const { shapeId } = command;
        const existing = editor.getShape(shapeId as TLShapeId);
        if (!existing) {
          console.warn("[delete_shape] Shape not found:", shapeId);
          break;
        }
        editor.deleteShape(shapeId as TLShapeId);
        console.log("[delete_shape] Deleted shape:", shapeId);
        break;
      }

      // ============================================
      // Undo last action
      // ============================================
      case "undo": {
        editor.undo();
        console.log("[undo] Undid last action");
        break;
      }

      // ============================================
      // Regular polygon / star by math
      // ============================================
      case "create_polygon": {
        const { sides, x: px, y: py, radius, rotation = 0, star = false, label } = command;
        if (!sides || sides < 3 || !radius) {
          console.warn("[create_polygon] Invalid params", command);
          break;
        }

        const vp = editor.getViewportPageBounds();
        let cx = px, cy = py;
        if (cx < vp.x || cx > vp.x + vp.w || cy < vp.y || cy > vp.y + vp.h) {
          cx = vp.x + vp.w / 2;
          cy = vp.y + vp.h / 2;
        }

        const rotRad = (rotation * Math.PI) / 180;
        const points: string[] = [];

        if (star) {
          const innerR = radius / 2.5;
          for (let i = 0; i < sides * 2; i++) {
            const angle = (i * Math.PI) / sides + rotRad - Math.PI / 2;
            const r = i % 2 === 0 ? radius : innerR;
            points.push(`${(r * Math.cos(angle)).toFixed(2)},${(r * Math.sin(angle)).toFixed(2)}`);
          }
        } else {
          for (let i = 0; i < sides; i++) {
            const angle = (2 * Math.PI * i) / sides + rotRad - Math.PI / 2;
            points.push(`${(radius * Math.cos(angle)).toFixed(2)},${(radius * Math.sin(angle)).toFixed(2)}`);
          }
        }

        const pad = radius * 0.1;
        const svgSize = (radius + pad) * 2;
        const offset = radius + pad;
        const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-offset} ${-offset} ${svgSize} ${svgSize}"><polygon points="${points.join(" ")}" fill="none" stroke="black" stroke-width="${(radius * 0.04).toFixed(1)}"/>${label ? `<text x="0" y="${(radius * 0.15).toFixed(1)}" text-anchor="middle" font-size="${(radius * 0.2).toFixed(1)}" fill="black">${label}</text>` : ""}</svg>`;

        const polyId = createShapeId();
        editor.createShape({
          id: polyId,
          type: "svg_shape",
          x: cx - offset,
          y: cy - offset,
          props: { w: svgSize, h: svgSize, svg: svgStr, color: "#1e293b" },
        } as any);
        createdShapeIds.push("created");
        editor.zoomToFit({ animation: { duration: 300 } });
        break;
      }

      // ============================================
      // Parametric Graph
      // ============================================
      case "create_parametric_graph": {
        const {
          exprX, exprY,
          tMin = 0, tMax = 2 * Math.PI,
          x: pgx = 0, y: pgy = 0,
          w: pgw = 400, h: pgh = 300,
          color: pgColor, label: pgLabel, title: pgTitle,
        } = command;

        const vp2 = editor.getViewportPageBounds();
        let pgxFinal = pgx, pgyFinal = pgy;
        if (pgxFinal < vp2.x || pgxFinal > vp2.x + vp2.w || pgyFinal < vp2.y || pgyFinal > vp2.y + vp2.h) {
          pgxFinal = vp2.x + vp2.w / 2 - pgw / 2;
          pgyFinal = vp2.y + vp2.h / 2 - pgh / 2;
        }

        const TSTEPS = 400;
        const tPoints: Array<{ x: number; y: number } | null> = [];
        for (let i = 0; i <= TSTEPS; i++) {
          const t = tMin + (i / TSTEPS) * (tMax - tMin);
          try {
            const xv = mathEvaluate(exprX, { t, pi: Math.PI, e: Math.E, ln: Math.log });
            const yv = mathEvaluate(exprY, { t, pi: Math.PI, e: Math.E, ln: Math.log });
            tPoints.push(typeof xv === "number" && typeof yv === "number" && isFinite(xv) && isFinite(yv) ? { x: xv, y: yv } : null);
          } catch { tPoints.push(null); }
        }

        const validPts = tPoints.filter(Boolean) as Array<{ x: number; y: number }>;
        if (validPts.length < 2) { console.warn("[create_parametric_graph] No valid points"); break; }

        const PADDING2 = { top: pgTitle ? 40 : 20, right: 20, bottom: 36, left: 44 };
        const plotW2 = pgw - PADDING2.left - PADDING2.right;
        const plotH2 = pgh - PADDING2.top - PADDING2.bottom;

        const allX = validPts.map(p => p.x), allY = validPts.map(p => p.y);
        const xMinP = Math.min(...allX), xMaxP = Math.max(...allX);
        const yMinP = Math.min(...allY), yMaxP = Math.max(...allY);
        const xRangeP = xMaxP - xMinP || 1, yRangeP = yMaxP - yMinP || 1;

        const toSX = (xv: number) => pgxFinal + PADDING2.left + ((xv - xMinP) / xRangeP) * plotW2;
        const toSY = (yv: number) => pgyFinal + PADDING2.top + ((yMaxP - yv) / yRangeP) * plotH2;

        const pgShapeIds: TLShapeId[] = [];
        const addPGShape = (data: Record<string, unknown>) => {
          const id = createShapeId();
          editor.createShape({ id, ...data } as any);
          pgShapeIds.push(id);
        };

        if (pgTitle) addPGShape({ type: "text", x: pgxFinal + pgw / 2 - 60, y: pgyFinal + 4, props: { richText: toRichText(pgTitle), size: "s", color: "black" } });

        const axisY2 = Math.max(pgyFinal + PADDING2.top, Math.min(pgyFinal + PADDING2.top + plotH2, toSY(0)));
        const axisX2 = Math.max(pgxFinal + PADDING2.left, Math.min(pgxFinal + PADDING2.left + plotW2, toSX(0)));
        addPGShape({ type: "arrow", x: pgxFinal + PADDING2.left, y: axisY2, props: { start: { x: 0, y: 0 }, end: { x: plotW2 + 12, y: 0 }, richText: toRichText(""), color: "black", size: "s" } });
        addPGShape({ type: "arrow", x: axisX2, y: pgyFinal + PADDING2.top + plotH2 + 12, props: { start: { x: 0, y: 0 }, end: { x: 0, y: -(plotH2 + 24) }, richText: toRichText(""), color: "black", size: "s" } });

        // Draw the parametric curve
        const curveColor = pgColor ?? "blue";
        const segments2: Array<Array<{ x: number; y: number }>> = [];
        let cur2: Array<{ x: number; y: number }> = [];
        for (const pt of tPoints) {
          if (!pt) { if (cur2.length >= 2) segments2.push(cur2); cur2 = []; continue; }
          const sx = toSX(pt.x), sy = toSY(pt.y);
          if (sy < pgyFinal + PADDING2.top - 2 || sy > pgyFinal + PADDING2.top + plotH2 + 2) { if (cur2.length >= 2) segments2.push(cur2); cur2 = []; continue; }
          cur2.push({ x: sx, y: sy });
        }
        if (cur2.length >= 2) segments2.push(cur2);

        for (const seg of segments2) {
          if (seg.length < 2) continue;
          const ox = seg[0].x, oy = seg[0].y;
          addPGShape({ type: "draw", x: ox, y: oy, props: { segments: [{ type: "free", path: b64Vecs.encodePoints(seg.map(p => ({ x: p.x - ox, y: p.y - oy, z: 0.5 }))) }], color: curveColor, size: "s", dash: "solid", isComplete: true, isClosed: false, isPen: false, scale: 1, scaleX: 1, scaleY: 1 } });
        }

        if (pgLabel) addPGShape({ type: "text", x: pgxFinal + PADDING2.left + 8, y: pgyFinal + PADDING2.top + 8, props: { richText: toRichText(pgLabel), size: "s", color: curveColor } });

        if (pgShapeIds.length > 1) editor.groupShapes(pgShapeIds);
        createdShapeIds.push("created");
        console.log("[create_parametric_graph] Created with", pgShapeIds.length, "shapes");
        break;
      }

      // ============================================
      // Board State Commands (Req 3.1, 3.2)
      // ============================================
      case "get_board_state": {
        updateBoardState(editor, boardState);
        const summary = getBoardStateSummary(boardState);
        // Build a compact shape list the agent can use for IDs and positions
        const shapeList = summary.shapes.map((s) => ({
          id: s.id,
          type: s.type,
          label: s.label ?? "",
          x: Math.round(s.bounds.x),
          y: Math.round(s.bounds.y),
          w: Math.round(s.bounds.w),
          h: Math.round(s.bounds.h),
        }));
        const responsePayload = JSON.stringify({
          op: "board_state_response",
          shapeCount: summary.shapeCount,
          shapes: shapeList,
        });
        console.log("[get_board_state] Returning", shapeList.length, "shapes to agent");
        // Publish back so the agent tool call gets the result
        targetState.lastBoardStateResponse = responsePayload;
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
      // ============================================
      // 3D Shape Commands (isometric projection)
      // ============================================
      case "create_3d_cube": {
        const { x: cx3, y: cy3, size, label: lbl3d, edgeLabels } = command;
        const { faces, edges } = calculateCubeProjection(cx3, cy3, size);
        const svgParts: string[] = [];
        for (const face of faces) {
          const pts = face.points.map((p) => `${(p.x - cx3).toFixed(1)},${(p.y - cy3).toFixed(1)}`).join(" ");
          svgParts.push(`<polygon points="${pts}" fill="${face.color}" stroke="black" stroke-width="1.5" opacity="0.85"/>`);
        }
        for (const edge of edges) {
          svgParts.push(`<line x1="${(edge.start.x - cx3).toFixed(1)}" y1="${(edge.start.y - cy3).toFixed(1)}" x2="${(edge.end.x - cx3).toFixed(1)}" y2="${(edge.end.y - cy3).toFixed(1)}" stroke="black" stroke-width="1.5"/>`);
        }
        if (lbl3d) svgParts.push(`<text x="0" y="${(size * 0.15).toFixed(1)}" text-anchor="middle" font-size="${(size * 0.18).toFixed(1)}" fill="black">${lbl3d}</text>`);
        const pad = size * 0.15;
        const allX = [...faces.flatMap((f) => f.points.map((p) => p.x)), ...edges.flatMap((e) => [e.start.x, e.end.x])];
        const allY = [...faces.flatMap((f) => f.points.map((p) => p.y)), ...edges.flatMap((e) => [e.start.y, e.end.y])];
        const minX = Math.min(...allX) - cx3 - pad, maxX = Math.max(...allX) - cx3 + pad;
        const minY = Math.min(...allY) - cy3 - pad, maxY = Math.max(...allY) - cy3 + pad;
        const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${(maxX - minX).toFixed(1)} ${(maxY - minY).toFixed(1)}">${svgParts.join("")}</svg>`;
        const shapeId3d = createShapeId();
        editor.createShape({ id: shapeId3d, type: "svg_shape", x: cx3 + minX, y: cy3 + minY, props: { w: maxX - minX, h: maxY - minY, svg: svgStr, color: "#1e293b" } } as any);
        createdShapeIds.push("created");
        break;
      }

      case "create_3d_prism": {
        const { x: px3, y: py3, width: pw, height: ph, depth: pd, triangular, label: pl } = command;
        const { faces, edges } = triangular
          ? calculateTriangularPrismProjection(px3, py3, pw, ph, pd)
          : calculatePrismProjection(px3, py3, pw, ph, pd);
        const svgParts: string[] = [];
        for (const face of faces) {
          const pts = face.points.map((p) => `${(p.x - px3).toFixed(1)},${(p.y - py3).toFixed(1)}`).join(" ");
          svgParts.push(`<polygon points="${pts}" fill="${face.color}" stroke="black" stroke-width="1.5" opacity="0.85"/>`);
        }
        for (const edge of edges) {
          svgParts.push(`<line x1="${(edge.start.x - px3).toFixed(1)}" y1="${(edge.start.y - py3).toFixed(1)}" x2="${(edge.end.x - px3).toFixed(1)}" y2="${(edge.end.y - py3).toFixed(1)}" stroke="black" stroke-width="1.5"/>`);
        }
        if (pl) svgParts.push(`<text x="0" y="0" text-anchor="middle" font-size="14" fill="black">${pl}</text>`);
        const allX3 = [...faces.flatMap((f) => f.points.map((p) => p.x)), ...edges.flatMap((e) => [e.start.x, e.end.x])];
        const allY3 = [...faces.flatMap((f) => f.points.map((p) => p.y)), ...edges.flatMap((e) => [e.start.y, e.end.y])];
        const pad3 = 10;
        const mnX = Math.min(...allX3) - px3 - pad3, mxX = Math.max(...allX3) - px3 + pad3;
        const mnY = Math.min(...allY3) - py3 - pad3, mxY = Math.max(...allY3) - py3 + pad3;
        const svgStr3 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mnX.toFixed(1)} ${mnY.toFixed(1)} ${(mxX - mnX).toFixed(1)} ${(mxY - mnY).toFixed(1)}">${svgParts.join("")}</svg>`;
        editor.createShape({ id: createShapeId(), type: "svg_shape", x: px3 + mnX, y: py3 + mnY, props: { w: mxX - mnX, h: mxY - mnY, svg: svgStr3, color: "#1e293b" } } as any);
        createdShapeIds.push("created");
        break;
      }

      case "create_3d_cylinder": {
        const { x: cylX, y: cylY, radius: cylR, height: cylH, label: cylL } = command;
        const { faces, edges } = calculateCylinderProjection(cylX, cylY, cylR, cylH);
        const svgParts: string[] = [];
        for (const face of faces) {
          const pts = face.points.map((p) => `${(p.x - cylX).toFixed(1)},${(p.y - cylY).toFixed(1)}`).join(" ");
          svgParts.push(`<polygon points="${pts}" fill="${face.color}" stroke="black" stroke-width="1.5" opacity="0.85"/>`);
        }
        for (const edge of edges) {
          svgParts.push(`<line x1="${(edge.start.x - cylX).toFixed(1)}" y1="${(edge.start.y - cylY).toFixed(1)}" x2="${(edge.end.x - cylX).toFixed(1)}" y2="${(edge.end.y - cylY).toFixed(1)}" stroke="black" stroke-width="1"/>`);
        }
        if (cylL) svgParts.push(`<text x="0" y="${(-cylH / 2 - 8).toFixed(1)}" text-anchor="middle" font-size="14" fill="black">${cylL}</text>`);
        const pad4 = 12;
        const allX4 = [...faces.flatMap((f) => f.points.map((p) => p.x))];
        const allY4 = [...faces.flatMap((f) => f.points.map((p) => p.y))];
        const mnX4 = Math.min(...allX4) - cylX - pad4, mxX4 = Math.max(...allX4) - cylX + pad4;
        const mnY4 = Math.min(...allY4) - cylY - pad4, mxY4 = Math.max(...allY4) - cylY + pad4;
        const svgStr4 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mnX4.toFixed(1)} ${mnY4.toFixed(1)} ${(mxX4 - mnX4).toFixed(1)} ${(mxY4 - mnY4).toFixed(1)}">${svgParts.join("")}</svg>`;
        editor.createShape({ id: createShapeId(), type: "svg_shape", x: cylX + mnX4, y: cylY + mnY4, props: { w: mxX4 - mnX4, h: mxY4 - mnY4, svg: svgStr4, color: "#1e293b" } } as any);
        createdShapeIds.push("created");
        break;
      }

      case "create_3d_cone": {
        const { x: coneX, y: coneY, radius: coneR, height: coneH, label: coneL } = command;
        const { faces, edges } = calculateConeProjection(coneX, coneY, coneR, coneH);
        const svgParts: string[] = [];
        for (const face of faces) {
          const pts = face.points.map((p) => `${(p.x - coneX).toFixed(1)},${(p.y - coneY).toFixed(1)}`).join(" ");
          svgParts.push(`<polygon points="${pts}" fill="${face.color}" stroke="black" stroke-width="1.5" opacity="0.85"/>`);
        }
        for (const edge of edges) {
          svgParts.push(`<line x1="${(edge.start.x - coneX).toFixed(1)}" y1="${(edge.start.y - coneY).toFixed(1)}" x2="${(edge.end.x - coneX).toFixed(1)}" y2="${(edge.end.y - coneY).toFixed(1)}" stroke="black" stroke-width="1"/>`);
        }
        if (coneL) svgParts.push(`<text x="0" y="${(-coneH - 8).toFixed(1)}" text-anchor="middle" font-size="14" fill="black">${coneL}</text>`);
        const pad5 = 12;
        const allX5 = [...faces.flatMap((f) => f.points.map((p) => p.x))];
        const allY5 = [...faces.flatMap((f) => f.points.map((p) => p.y))];
        const mnX5 = Math.min(...allX5) - coneX - pad5, mxX5 = Math.max(...allX5) - coneX + pad5;
        const mnY5 = Math.min(...allY5) - coneY - pad5, mxY5 = Math.max(...allY5) - coneY + pad5;
        const svgStr5 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mnX5.toFixed(1)} ${mnY5.toFixed(1)} ${(mxX5 - mnX5).toFixed(1)} ${(mxY5 - mnY5).toFixed(1)}">${svgParts.join("")}</svg>`;
        editor.createShape({ id: createShapeId(), type: "svg_shape", x: coneX + mnX5, y: coneY + mnY5, props: { w: mxX5 - mnX5, h: mxY5 - mnY5, svg: svgStr5, color: "#1e293b" } } as any);
        createdShapeIds.push("created");
        break;
      }

      case "create_3d_pyramid": {
        const { x: pyrX, y: pyrY, baseSize: pyrB, height: pyrH, label: pyrL } = command;
        const { faces, edges } = calculatePyramidProjection(pyrX, pyrY, pyrB, pyrH);
        const svgParts: string[] = [];
        for (const face of faces) {
          const pts = face.points.map((p) => `${(p.x - pyrX).toFixed(1)},${(p.y - pyrY).toFixed(1)}`).join(" ");
          svgParts.push(`<polygon points="${pts}" fill="${face.color}" stroke="black" stroke-width="1.5" opacity="0.85"/>`);
        }
        for (const edge of edges) {
          svgParts.push(`<line x1="${(edge.start.x - pyrX).toFixed(1)}" y1="${(edge.start.y - pyrY).toFixed(1)}" x2="${(edge.end.x - pyrX).toFixed(1)}" y2="${(edge.end.y - pyrY).toFixed(1)}" stroke="black" stroke-width="1.5"/>`);
        }
        if (pyrL) svgParts.push(`<text x="0" y="${(-pyrH - 8).toFixed(1)}" text-anchor="middle" font-size="14" fill="black">${pyrL}</text>`);
        const pad6 = 12;
        const allX6 = [...faces.flatMap((f) => f.points.map((p) => p.x))];
        const allY6 = [...faces.flatMap((f) => f.points.map((p) => p.y))];
        const mnX6 = Math.min(...allX6) - pyrX - pad6, mxX6 = Math.max(...allX6) - pyrX + pad6;
        const mnY6 = Math.min(...allY6) - pyrY - pad6, mxY6 = Math.max(...allY6) - pyrY + pad6;
        const svgStr6 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mnX6.toFixed(1)} ${mnY6.toFixed(1)} ${(mxX6 - mnX6).toFixed(1)} ${(mxY6 - mnY6).toFixed(1)}">${svgParts.join("")}</svg>`;
        editor.createShape({ id: createShapeId(), type: "svg_shape", x: pyrX + mnX6, y: pyrY + mnY6, props: { w: mxX6 - mnX6, h: mxY6 - mnY6, svg: svgStr6, color: "#1e293b" } } as any);
        createdShapeIds.push("created");
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

/**
 * BoardSnapshotPublisher — replaces the continuous video track.
 *
 * Sends a PNG snapshot of the board via LiveKit data message (topic: board.snapshot)
 * under three conditions:
 *   1. Local participant starts speaking — always send immediately (AI needs current board)
 *   2. Board changes while AI is NOT speaking — debounce 1.5s (wait for stroke to finish)
 *   3. Board changes while AI IS speaking — send immediately (AI mid-sentence needs update)
 *
 * The agent receives these snapshots and forwards them to Gemini Live as inline images.
 * This replaces the continuous video stream, eliminating the 2-minute session limit
 * while preserving full visual awareness of the board.
 */
function BoardSnapshotPublisher({
  isConnected,
  editor,
}: {
  isConnected: boolean;
  editor: Editor | null;
}) {
  const room = useRoomContext();
  const debounceRef = useRef<number | null>(null);
  const lastSnapshotHashRef = useRef<string>("");
  const aiSpeakingRef = useRef<boolean>(false);

  const captureAndSend = useCallback(async () => {
    if (!editor || !isConnected) return;
    try {
      const pageShapeIds = [...editor.getCurrentPageShapeIds()];
      if (pageShapeIds.length === 0) return;

      // Try progressively lower scales until we fit under the size cap.
      // Freehand strokes render as complex anti-aliased paths and can be
      // large at 40% — we try 40% → 25% → 15% before giving up.
      const scales = [0.4, 0.25, 0.15];
      const SIZE_CAP = 60_000; // 60KB — raised from 30KB; freehand needs more room

      let bytes: Uint8Array | null = null;
      for (const scale of scales) {
        const imageResult = await editor.toImage(pageShapeIds, {
          format: "png",
          background: true,
          padding: 16,
          scale,
        });
        const buf = await imageResult.blob.arrayBuffer();
        const candidate = new Uint8Array(buf);
        if (candidate.length <= SIZE_CAP) {
          bytes = candidate;
          break;
        }
        console.debug(
          `[BoardSnapshotPublisher] scale=${scale} too large (${candidate.length}B), trying smaller`
        );
      }

      if (!bytes) {
        console.debug("[BoardSnapshotPublisher] All scales exceeded cap, skipping snapshot");
        return;
      }

      // Better hash: sample 8 bytes spread across the buffer
      const step = Math.max(1, Math.floor(bytes.length / 8));
      let hash = bytes.length.toString();
      for (let i = 0; i < bytes.length; i += step) hash += bytes[i];
      if (hash === lastSnapshotHashRef.current) return;
      lastSnapshotHashRef.current = hash;

      // Convert to base64 in chunks to avoid call-stack overflow on large buffers
      const CHUNK = 8192;
      let binary = "";
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const b64 = btoa(binary);

      const payload = JSON.stringify({ type: "board.snapshot", image_b64: b64, mime: "image/png" });
      // Use reliable channel for snapshots — freehand strokes are the primary
      // visual input and must not be dropped on a lossy connection.
      await room.localParticipant.publishData(
        new TextEncoder().encode(payload),
        { reliable: true, topic: "board.snapshot" }
      );
      console.debug(`[BoardSnapshotPublisher] Sent snapshot ${bytes.length}B`);
    } catch (e) {
      console.warn("[BoardSnapshotPublisher] Failed to capture/send snapshot:", e);
    }
  }, [editor, isConnected, room]);

  useEffect(() => {
    if (!isConnected || !editor) return;

    // Track AI speaking state via remote participant events
    const onParticipantSpeakingChanged = (speaking: boolean) => {
      aiSpeakingRef.current = speaking;
    };

    // Listen to all remote participants for speaking changes
    room.on("participantSpeakingChanged" as any, (_participant: any, speaking: boolean) => {
      // Only track the agent participant (not local)
      if (_participant.identity !== room.localParticipant.identity) {
        onParticipantSpeakingChanged(speaking);
      }
    });

    // Trigger 1: local participant starts speaking → send immediately
    const onLocalSpeakingChanged = () => {
      if (room.localParticipant.isSpeaking) {
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        void captureAndSend();
      }
    };
    room.localParticipant.on("isSpeakingChanged", onLocalSpeakingChanged);

    // Trigger 2 & 3: board changes
    const removeStoreListener = editor.store.listen(
      () => {
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }

        if (aiSpeakingRef.current) {
          // AI is speaking — send immediately so it can react mid-sentence
          void captureAndSend();
        } else {
          // AI is silent — debounce to wait for stroke completion.
          // 600ms is enough for a freehand stroke to finish without flooding.
          debounceRef.current = window.setTimeout(() => {
            void captureAndSend();
            debounceRef.current = null;
          }, 600);
        }
      },
      { source: "user", scope: "document" } // only user-initiated changes
    );

    // Send initial snapshot when connected
    void captureAndSend();

    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      room.localParticipant.off("isSpeakingChanged", onLocalSpeakingChanged);
      room.off("participantSpeakingChanged" as any, onParticipantSpeakingChanged);
      removeStoreListener();
    };
  }, [editor, isConnected, room, captureAndSend]);

  return null;
}

/**
 * BoardContextPublisher — publishes board.delta, board.selection, board.cursor
 * over LiveKit data topics so the agent always has live board context.
 *
 * board.delta   — compact shape change summary (add/update/delete), debounced 300ms
 * board.selection — selected shape IDs, published on every selection change
 * board.cursor  — pointer position, throttled to ~10Hz (100ms)
 *
 * These replace the need for the agent to poll get_board_state every turn.
 * The agent accumulates them in _board_delta_summary, _board_selection, _board_cursor.
 */
function BoardContextPublisher({
  isConnected,
  editor,
}: {
  isConnected: boolean;
  editor: Editor | null;
}) {
  const room = useRoomContext();
  const deltaDebouncerRef = useRef<number | null>(null);
  const cursorThrottleRef = useRef<number>(0);
  const lastSelectionRef = useRef<string>("");

  const publishDelta = useCallback(
    (op: "add" | "update" | "delete", shapes: Array<{ id: string; type: string; label: string; x: number; y: number; w: number; h: number }>, shapeCount: number) => {
      if (!isConnected) return;
      const payload = JSON.stringify({ op, shapes, shapeCount });
      room.localParticipant
        .publishData(new TextEncoder().encode(payload), { reliable: false, topic: "board.delta" })
        .catch(() => {});
    },
    [isConnected, room]
  );

  const publishSelection = useCallback(
    (selectedIds: string[]) => {
      if (!isConnected) return;
      const key = selectedIds.sort().join(",");
      if (key === lastSelectionRef.current) return; // deduplicate
      lastSelectionRef.current = key;
      const payload = JSON.stringify({ selectedIds, count: selectedIds.length });
      room.localParticipant
        .publishData(new TextEncoder().encode(payload), { reliable: true, topic: "board.selection" })
        .catch(() => {});
    },
    [isConnected, room]
  );

  const publishCursor = useCallback(
    (x: number, y: number) => {
      if (!isConnected) return;
      const now = Date.now();
      if (now - cursorThrottleRef.current < 100) return; // 10Hz throttle
      cursorThrottleRef.current = now;
      const payload = JSON.stringify({ x: Math.round(x), y: Math.round(y) });
      room.localParticipant
        .publishData(new TextEncoder().encode(payload), { reliable: false, topic: "board.cursor" })
        .catch(() => {});
    },
    [isConnected, room]
  );

  useEffect(() => {
    if (!isConnected || !editor) return;

    // Track previous shape set for delta detection
    let prevShapeIds = new Set<string>(
      [...editor.getCurrentPageShapeIds()].map(String)
    );

    // board.delta — debounced store listener
    const removeStoreListener = editor.store.listen(
      () => {
        if (deltaDebouncerRef.current) {
          window.clearTimeout(deltaDebouncerRef.current);
        }
        deltaDebouncerRef.current = window.setTimeout(() => {
          deltaDebouncerRef.current = null;
          const currentIds = new Set<string>(
            [...editor.getCurrentPageShapeIds()].map(String)
          );
          const added = [...currentIds].filter((id) => !prevShapeIds.has(id));
          const removed = [...prevShapeIds].filter((id) => !currentIds.has(id));
          prevShapeIds = currentIds;

          const op = removed.length > 0 && added.length === 0 ? "delete"
            : added.length > 0 && removed.length === 0 ? "add"
            : "update";

          // Build compact shape descriptors for changed shapes
          const changedIds = op === "delete" ? removed : added.length > 0 ? added : [...currentIds].slice(0, 5);
          const shapes = changedIds.slice(0, 8).map((id) => {
            const shape = editor.getShape(id as any);
            const bounds = shape ? editor.getShapePageBounds(shape) : null;
            return {
              id,
              type: shape?.type ?? "unknown",
              label: (shape?.props as any)?.text ?? (shape?.props as any)?.richText ?? "",
              x: Math.round(bounds?.x ?? 0),
              y: Math.round(bounds?.y ?? 0),
              w: Math.round(bounds?.w ?? 0),
              h: Math.round(bounds?.h ?? 0),
            };
          });

          publishDelta(op, shapes, currentIds.size);
        }, 300);
      },
      { source: "user", scope: "document" }
    );

    // board.selection — listen to selection changes
    const removeSelectionListener = editor.store.listen(
      () => {
        const selected = [...editor.getSelectedShapeIds()].map(String);
        publishSelection(selected);
      },
      { source: "user", scope: "session" }
    );

    // board.cursor — poll pointer position at ~10Hz
    const cursorInterval = window.setInterval(() => {
      if (!editor) return;
      const pt = editor.inputs.getCurrentPagePoint();
      publishCursor(pt.x, pt.y);
    }, 100);

    return () => {
      if (deltaDebouncerRef.current) window.clearTimeout(deltaDebouncerRef.current);
      window.clearInterval(cursorInterval);
      removeStoreListener();
      removeSelectionListener();
    };
  }, [editor, isConnected, publishDelta, publishSelection, publishCursor]);

  return null;
}

function BoardCommandBridge({
  isConnected,
  editor,
  targetStateRef,
  boardStateRef,
  onSourcesUpdate,
  pendingLearnerContextRef,
}: {
  isConnected: boolean;
  editor: Editor | null;
  targetStateRef: { current: BoardTargetState };
  boardStateRef: { current: BoardState };
  onSourcesUpdate?: (sources: SourceAttribution[], isGeneralKnowledge: boolean, navigateTo: NavigationTarget | null) => void;
  pendingLearnerContextRef: { current: LearnerSelection | null };
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
      if (topic !== "board.command") {
        // Handle tutor.sources for RAG source transparency
        if (topic === "tutor.sources") {
          try {
            const rawText = new TextDecoder().decode(payload);
            const sourcesPayload = JSON.parse(rawText) as SourcesPayload & { navigate_to?: NavigationTarget };
            onSourcesUpdate?.(sourcesPayload.sources ?? [], sourcesPayload.is_general_knowledge ?? true, sourcesPayload.navigate_to ?? null);
          } catch (e) {
            console.warn("[SourcePanel] Failed to parse tutor.sources payload:", e);
          }
        }
        return;
      }

      try {
        const rawText = new TextDecoder().decode(payload);
        console.log("[BoardCommandBridge] Raw payload:", rawText.substring(0, 200));
        const command = JSON.parse(rawText) as BoardCommand;
        console.log("[BoardCommandBridge] Received command:", command.op, command);
        applyBoardCommand(editor, command, targetStateRef.current, boardStateRef.current);

        // If the command was get_board_state, publish the response back to the agent
        if (command.op === "get_board_state" && targetStateRef.current.lastBoardStateResponse) {
          const responseData = targetStateRef.current.lastBoardStateResponse;
          targetStateRef.current.lastBoardStateResponse = null;
          room.localParticipant.publishData(
            new TextEncoder().encode(responseData),
            { reliable: true, topic: "board.response" }
          ).catch((e) => console.warn("[BoardCommandBridge] Failed to publish board response:", e));
        }
      } catch (error) {
        console.error("[BoardCommandBridge] Failed to parse/apply board command:", error);
      }
    };

    room.on("dataReceived", onDataReceived);

    // Poll for pending learner context selections and publish them
    const learnerContextInterval = window.setInterval(() => {
      const pending = pendingLearnerContextRef.current;
      if (!pending) return;
      pendingLearnerContextRef.current = null;
      const data = JSON.stringify(pending);
      room.localParticipant.publishData(
        new TextEncoder().encode(data),
        { reliable: true, topic: "learner.context" }
      ).catch((e) => console.warn("[BoardCommandBridge] Failed to publish learner.context:", e));
    }, 200);

    return () => {
      room.off("dataReceived", onDataReceived);
      window.clearInterval(learnerContextInterval);
    };
  }, [editor, isConnected, room, targetStateRef, pendingLearnerContextRef]);

  return null;
}

export function TabloWorkspace({ authToken }: { authToken?: string | null }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const targetStateRef = useRef<BoardTargetState>({
    lastPointerPagePoint: null,
    pointerShapeId: null,
    thisShapeId: null,
    thatShapeId: null,
    lastBoardStateResponse: null,
  });
  const boardStateRef = useRef<BoardState>(createBoardState());
  const pendingLearnerContextRef = useRef<LearnerSelection | null>(null);
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
  const [ragSources, setRagSources] = useState<SourceAttribution[]>([]);
  const [ragIsGeneralKnowledge, setRagIsGeneralKnowledge] = useState(true);
  const [viewerDocuments, setViewerDocuments] = useState<DocumentMeta[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [activeNavigation, setActiveNavigation] = useState<NavigationTarget | null>(null);
  const [roomDetails, setRoomDetails] = useState<{
    roomName: string;
    participantIdentity: string;
    serverUrl?: string;
    token?: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  // Session management
  type SessionInfo = {
    id: string;
    name: string;
    learner_id: string;
    doc_ids: string[];
    active_doc_id: string | null;
    created_at: string;
    last_accessed: string;
  };
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionNotes, setSessionNotes] = useState<{text: string; timestamp: string}[]>([]);
  const [showNotes, setShowNotes] = useState(false);

  // Build auth headers from the session token (must be before createNewSession)
  const authHeaders = useCallback((): Record<string, string> => {
    const token = authToken ?? sessionStorage.getItem("tablo_token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [authToken]);

  // Create new session
  const createNewSession = useCallback(async (name?: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/sessions`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const newSession = await res.json();
        setSessions(prev => [newSession, ...prev]);
        setCurrentSessionId(newSession.id);
        return newSession;
      }
    } catch (e) {
      console.error("Failed to create session:", e);
    }
    return null;
  }, [authHeaders]);

  // Fetch sessions on mount (after authHeaders is defined)
  useEffect(() => {
    async function fetchSessions() {
      try {
        const res = await fetch(`${API_BASE_URL}/sessions`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setSessions(data);
          // Set current session to first one or create default
          if (data.length > 0) {
            setCurrentSessionId(data[0].id);
            // Note: documents and board will be loaded by the useEffect when currentSessionId changes
          }
        }
      } catch (e) {
        console.error("Failed to fetch sessions:", e);
      }
    }
    fetchSessions();
  }, [authHeaders]);

  // Load board state and documents when currentSessionId is set or changes
  // This runs when currentSessionId changes, including on initial load
  useEffect(() => {
    if (!currentSessionId) return;

    // Load documents, board, and notes when session changes
    const timer = setTimeout(() => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadSessionDocuments(currentSessionId);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadBoardState(currentSessionId);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadSessionNotes(currentSessionId);
    }, 500);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  // Load session notes from backend
  const loadSessionNotes = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/sessions/${sessionId}/notes`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setSessionNotes(data.notes || []);
      } else {
        setSessionNotes([]);
      }
    } catch {
      setSessionNotes([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapSession() {
      setStatus("loading");
      setErrorMessage("");

      try {
        const headers = authHeaders();
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

          // Fetch document list
          try {
            const docsRes = await fetch(`${API_BASE_URL}/documents`, {
              headers: authHeaders(),
            });
            if (docsRes.ok) {
              const docs = await docsRes.json();
              if (!cancelled) setViewerDocuments(docs);
            }
          } catch { /* non-fatal */ }
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

  // Helper: save current board state to localStorage (fast, synchronous)
  const saveBoardState = useCallback((sessionId: string) => {
    if (!editor) return;
    try {
      const storeSnapshot = getSnapshot(editor.store);
      const key = `tablo_board_${sessionId}`;
      localStorage.setItem(key, JSON.stringify(storeSnapshot));
    } catch (e) {
      console.error("Failed to save board state to localStorage:", e);
    }
  }, [editor]);

  // Helper: sync board state to backend (async, called on interval)
  const syncBoardToBackend = useCallback(async (sessionId: string) => {
    if (!editor) return;
    try {
      const storeSnapshot = getSnapshot(editor.store);
      await fetch(`${API_BASE_URL}/sessions/${sessionId}/board`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(storeSnapshot),
      });
      console.log("[Board] Synced to backend:", sessionId);
    } catch (e) {
      console.warn("[Board] Backend sync failed (non-critical):", e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Auto-save board state: localStorage on every change, backend every 5 seconds
  useEffect(() => {
    if (!editor || !currentSessionId) return;

    // Save to localStorage immediately on every document change
    const cleanup = editor.store.listen(
      () => {
        saveBoardState(currentSessionId);
      },
      { scope: "document", source: "user" }
    );

    // Sync to backend every 5 seconds
    const intervalId = setInterval(() => {
      saveBoardState(currentSessionId);
      syncBoardToBackend(currentSessionId);
    }, 5000);

    return () => {
      cleanup();
      clearInterval(intervalId);
    };
  }, [editor, currentSessionId, saveBoardState, syncBoardToBackend]);

  // Helper: load board state — tries backend first, falls back to localStorage
  const loadBoardState = useCallback(async (sessionId: string) => {
    if (!editor) return;
    try {
      // Try backend first (server-side persistence — works across browsers)
      const res = await fetch(`${API_BASE_URL}/sessions/${sessionId}/board`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const storeSnapshot = await res.json();
        loadSnapshot(editor.store, storeSnapshot);
        // Update localStorage cache
        localStorage.setItem(`tablo_board_${sessionId}`, JSON.stringify(storeSnapshot));
        console.log("[Board] Loaded from backend:", sessionId);
        return;
      }
    } catch (e) {
      console.warn("[Board] Backend load failed, trying localStorage:", e);
    }
    // Fall back to localStorage
    try {
      const key = `tablo_board_${sessionId}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        const storeSnapshot = JSON.parse(saved);
        loadSnapshot(editor.store, storeSnapshot);
        console.log("[Board] Loaded from localStorage:", sessionId);
      }
    } catch (e) {
      console.error("Failed to load board state:", e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Helper: clear the board (for new sessions)
  const clearBoard = useCallback(() => {
    if (!editor) return;
    try {
      // Get all shapes on the current page and delete them
      const shapeIds = Array.from(editor.getCurrentPageShapeIds());
      
      // Delete all shapes at once (safer than store.clear())
      if (shapeIds.length > 0) {
        editor.store.remove(shapeIds);
      }
    } catch (e) {
      console.error("Failed to clear board:", e);
    }
  }, [editor]);

  async function connectLiveKit() {
    if (!session || !realtimeConfig?.configured) {
      setErrorMessage(
        "LiveKit is not configured yet. Add LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to the backend."
      );
      return;
    }

    // Use current session ID or default to session.session_id
    await connectLiveKitWithSession(currentSessionId || session.session_id);
  }

  async function connectLiveKitWithSession(sessionId: string) {
    if (!session || !realtimeConfig?.configured) {
      setErrorMessage(
        "LiveKit is not configured yet. Add LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to the backend."
      );
      return;
    }

    setRoomState("connecting");
    setErrorMessage("");

    try {
      // Save current session's board before switching
      if (currentSessionId && editor) {
        saveBoardState(currentSessionId);
      }

      const tokenRes = await fetch(`${API_BASE_URL}/livekit/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          session_id: sessionId,
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

      // Load the new session's board state after connecting
      setTimeout(() => {
        loadBoardState(sessionId);
      }, 1000);
    } catch (error) {
      setRoomState("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while connecting to LiveKit."
      );
    }
  }

  // Helper: load session-specific documents
  const loadSessionDocuments = useCallback(async (sessionId: string) => {
    console.log("[Docs] Loading documents for session:", sessionId);
    try {
      // Get session to find its document IDs
      const sessionRes = await fetch(`${API_BASE_URL}/sessions/${sessionId}`, {
        headers: authHeaders(),
      });
      if (!sessionRes.ok) {
        console.log("[Docs] Session fetch failed:", sessionRes.status);
        return;
      }
      
      const sessionData = await sessionRes.json();
      const sessionDocIds = sessionData.doc_ids || [];
      const activeDocId = sessionData.active_doc_id;
      console.log("[Docs] Session has doc_ids:", sessionDocIds, "active:", activeDocId);
      
      if (sessionDocIds.length === 0) {
        // No documents in this session yet
        console.log("[Docs] No documents in this session, clearing viewer");
        setViewerDocuments([]);
        setActiveDocId(null);
        return;
      }
      
      // Fetch all documents and filter by session's doc_ids
      const allDocsRes = await fetch(`${API_BASE_URL}/documents`, {
        headers: authHeaders(),
      });
      if (!allDocsRes.ok) {
        console.log("[Docs] All docs fetch failed:", allDocsRes.status);
        return;
      }
      
      const allDocs = await allDocsRes.json();
      const sessionDocs = allDocs.filter((doc: DocumentMeta) => sessionDocIds.includes(doc.doc_id));
      console.log("[Docs] Found session docs:", sessionDocs.map((d: DocumentMeta) => d.name));
      
      setViewerDocuments(sessionDocs);
      setActiveDocId(activeDocId);
    } catch (e) {
      console.error("Failed to load session documents:", e);
    }
  }, [authHeaders]);

  // Handle session change - save board, disconnect, switch session, load session data, reconnect
  const handleSessionChange = useCallback(async (newSessionId: string) => {
    // Don't do anything if same session
    if (newSessionId === currentSessionId) return;

    // Save current board state to backend before switching
    if (currentSessionId && editor) {
      saveBoardState(currentSessionId);
      await syncBoardToBackend(currentSessionId);
    }

    // Disconnect from current LiveKit room
    disconnectLiveKit();

    // Update session ID - this triggers the useEffect to load the new session's board
    setCurrentSessionId(newSessionId);

    // Note: Board and documents for new session are loaded automatically by useEffect
    // Give the LiveKit room time to fully disconnect before reconnecting
    setTimeout(() => {
      connectLiveKitWithSession(newSessionId);
    }, 1200);
  }, [currentSessionId, editor, saveBoardState, syncBoardToBackend, loadSessionDocuments]);


  // Handle new session creation - create new session and clear board
  const handleCreateNewSession = useCallback(async () => {
    // Save current board before creating new session
    if (currentSessionId && editor) {
      saveBoardState(currentSessionId);
    }

    // Create new session via API
    const newSession = await createNewSession();
    if (newSession) {
      // Disconnect from current session
      disconnectLiveKit();

      // Update session ID (createNewSession already sets it)
      // Don't manually set it here to avoid race conditions

      // Clear board after a delay for the new session
      setTimeout(() => {
        if (editor) {
          try {
            const shapeIds = Array.from(editor.getCurrentPageShapeIds());
            if (shapeIds.length > 0) {
              editor.store.remove(shapeIds);
            }
          } catch (e) {
            console.error("Failed to clear board:", e);
          }
        }
      }, 300);

      // Load documents for new session (will be empty for new session)
      loadSessionDocuments(newSession.id);

      // Connect to the new session
      setTimeout(() => {
        connectLiveKitWithSession(newSession.id);
      }, 800);
    }
  }, [currentSessionId, editor, saveBoardState, createNewSession, loadSessionDocuments]);

  function disconnectLiveKit() {
    setRoomDetails(null);
    setRoomState("idle");
  }

  return (
    <LiveKitRoom
      serverUrl={roomDetails?.serverUrl}
      token={roomDetails?.token}
      connect={!!roomDetails}
      audio={{
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }}
      video={false}
      onConnected={() => setRoomState("connected")}
      onDisconnected={() => {
        setRoomState("idle");
        setRoomDetails(null);
      }}
    >
      <RoomAudioRenderer muted={false} />
      <BoardSnapshotPublisher isConnected={roomState === "connected"} editor={editor} />
      <BoardContextPublisher isConnected={roomState === "connected"} editor={editor} />
      <BoardCommandBridge
        isConnected={roomState === "connected"}
        editor={editor}
        targetStateRef={targetStateRef}
        boardStateRef={boardStateRef}
        pendingLearnerContextRef={pendingLearnerContextRef}
        onSourcesUpdate={(sources, isGK, navigateTo) => {
          setRagSources(sources);
          setRagIsGeneralKnowledge(isGK);
          if (navigateTo) {
            setActiveNavigation(navigateTo);
          }
        }}
      />
      <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.2),_transparent_30%),linear-gradient(180deg,_#113c66_0%,_#0a1d2f_50%,_#07111a_100%)] text-slate-50 flex flex-col">
        <div className="relative flex min-h-screen flex-col">

        <section className="flex min-h-screen flex-1">
          <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0">
              <Tldraw onMount={setEditor} autoFocus shapeUtils={svgShapeUtils} />
            </div>
            {/* Document viewer panel — overlays on the right side of the canvas */}
            <DocumentViewerPanel
              documents={viewerDocuments}
              activeNavigation={activeNavigation}
              activeDocId={activeDocId}
              isConnected={roomState === "connected"}
              onLearnerSelection={(selection) => {
                if (roomState !== "connected") return;
                pendingLearnerContextRef.current = selection;
              }}
              onRefreshDocuments={() => {
                // Refresh session-specific documents after upload
                if (currentSessionId) {
                  loadSessionDocuments(currentSessionId);
                }
              }}
              onSelectDocument={(docId) => {
                setActiveDocId(docId);
                // Update session's active doc
                if (currentSessionId) {
                  fetch(`${API_BASE_URL}/sessions/${currentSessionId}/active-doc`, {
                    method: "PATCH",
                    headers: { ...authHeaders(), "Content-Type": "application/json" },
                    body: JSON.stringify({ doc_id: docId }),
                  }).catch(() => {});
                }
              }}
            />
          </div>

        </section>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-6 md:px-6 md:pb-8 flex flex-col items-center justify-end">
          {/* Source transparency panel — only shown when connected */}
          {roomState === "connected" && (
            <SourcePanel
              sources={ragSources}
              isGeneralKnowledge={ragIsGeneralKnowledge}
            />
          )}
          
          <div className="pointer-events-auto relative mt-4">
            {/* Floating Board Status Pill */}
            {roomState === "connected" && (
              <div className="absolute -top-12 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-[#1A2F4B]/80 px-4 py-1.5 text-xs font-medium text-slate-200 backdrop-blur-md shadow-lg flex items-center gap-2 whitespace-nowrap transition-all duration-300 hover:bg-[#1A2F4B]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#EF7060] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#EF7060]"></span>
                </span>
                {boardMetrics.summary}
              </div>
            )}

            {/* Main Control Bar */}
            <div className="mx-auto flex w-max max-w-full items-center gap-4 rounded-2xl border border-white/10 bg-[#1A2F4B]/85 px-4 py-3 shadow-[0_16px_40px_rgba(0,0,0,0.4)] backdrop-blur-xl transition-all duration-300">
              {roomState === "connected" ? (
                <div className="flex items-center gap-3" data-lk-theme="default">
                  
                  {/* Session Selector */}
                  <div className="flex flex-col">
                    <span className="text-[9px] font-bold tracking-wider text-[#FCF8F3]/60 uppercase px-1 mb-0.5">Session</span>
                    <select
                      className="appearance-none rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 pr-8 text-sm font-medium text-[#FCF8F3] transition-colors hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[#EF7060]/50"
                      value={currentSessionId || ""}
                      onChange={(e) => handleSessionChange(e.target.value)}
                      style={{ 
                        backgroundImage: `url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23FCF8F3' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e")`, 
                        backgroundRepeat: 'no-repeat', 
                        backgroundPosition: 'right 0.6rem center', 
                        backgroundSize: '1em' 
                      }}
                    >
                      {sessions.map((s) => (
                        <option key={s.id} value={s.id} className="bg-[#1A2F4B] text-[#FCF8F3]">
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="h-8 w-px bg-white/10 mx-1"></div>

                  {/* New Topic Button */}
                  <button
                    className="group relative flex items-center justify-center rounded-lg bg-white/5 p-2 text-[#EF7060] transition-all hover:bg-[#EF7060] hover:text-white"
                    onClick={handleCreateNewSession}
                    type="button"
                    title="Create new topic"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>

                   {/* Upload Document Button */}
                  <div className="flex items-center">
                    <DocumentUploadButton authHeaders={authHeaders()} sessionId={currentSessionId} />
                  </div>

                  {/* Session Notes Button */}
                  <div className="relative">
                    <button
                      className={`group relative flex items-center justify-center rounded-lg p-2 text-sm transition-all ${showNotes ? "bg-[#EF7060] text-white" : "bg-white/5 text-[#FCF8F3]/70 hover:bg-white/10 hover:text-[#FCF8F3]"}`}
                      onClick={() => {
                        setShowNotes(v => !v);
                        if (!showNotes && currentSessionId) loadSessionNotes(currentSessionId);
                      }}
                      title="Session notes"
                      type="button"
                    >
                      📝
                    </button>
                    {showNotes && (
                      <div
                        className="absolute bottom-full mb-2 right-0 w-72 rounded-xl border border-white/10 bg-[#1A2F4B]/97 shadow-2xl backdrop-blur-xl overflow-hidden"
                        style={{ zIndex: 500 }}
                      >
                        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                          <span className="text-[10px] font-bold tracking-widest text-[#FCF8F3]/50 uppercase">Session Notes</span>
                          <button onClick={() => setShowNotes(false)} className="text-[#FCF8F3]/40 hover:text-[#FCF8F3] text-xs">✕</button>
                        </div>
                        <div className="max-h-64 overflow-y-auto p-2">
                          {sessionNotes.length === 0 ? (
                            <p className="text-xs text-[#FCF8F3]/40 text-center py-4">No notes yet — Tablo will add notes as you learn.</p>
                          ) : (
                            [...sessionNotes].reverse().map((note, i) => (
                              <div key={i} className="mb-2 rounded-lg bg-white/5 p-2.5">
                                <p className="text-xs text-[#FCF8F3]/90 leading-relaxed">{note.text}</p>
                                <p className="mt-1 text-[10px] text-[#FCF8F3]/30">
                                  {new Date(note.timestamp).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="h-8 w-px bg-white/10 mx-1"></div>

                  {/* LiveKit Controls Wrapper */}
                  {/* We use Tailwind arbitrary selectors to override LiveKit's default styles */}
                  <div className="flex items-center rounded-xl bg-black/30 p-1 pl-2 [&_.lk-control-bar]:!bg-transparent [&_.lk-control-bar]:!border-none [&_.lk-control-bar]:!shadow-none [&_.lk-button]:!bg-transparent [&_.lk-button]:hover:!bg-white/10 [&_.lk-disconnect-button]:!bg-[#EF7060] [&_.lk-disconnect-button]:hover:!bg-[#d95d4e] [&_.lk-disconnect-button]:!border-none [&_.lk-disconnect-button]:!rounded-lg [&_.lk-disconnect-button]:!ml-2 [&_.lk-audio-visualizer]:!opacity-80">
                    <VoiceAssistantControlBar />
                  </div>

                </div>
              ) : (
                <div className="flex items-center gap-6 px-2">
                  {/* Tablo Logo */}
                  <img 
                    src="/tablo.webp" 
                    alt="Tablo" 
                    className="h-9 w-auto object-contain drop-shadow-md"
                  />
                  <button
                    className="group relative flex items-center gap-2 rounded-full bg-gradient-to-r from-[#EF7060] to-[#f28b7e] px-8 py-3 text-sm font-bold text-white shadow-[0_0_20px_rgba(239,112,96,0.3)] transition-all hover:scale-105 hover:shadow-[0_0_30px_rgba(239,112,96,0.5)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                    disabled={roomState === "connecting"}
                    onClick={connectLiveKit}
                    type="button"
                  >
                    {roomState === "connecting" ? (
                      <span className="flex items-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Connecting...
                      </span>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                          <line x1="12" y1="19" x2="12" y2="22"></line>
                        </svg>
                        Talk to Tablo
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    {/* Footer with branding */}
      <footer 
        className="flex items-center justify-between px-6 py-3 text-xs"
        style={{ 
          backgroundColor: '#1A2F4B', 
          color: '#FCF8F3',
          borderTop: '1px solid rgba(255,255,255,0.1)'
        }}
      >
        <div className="flex items-center gap-2">
          <img 
            src="/tablo.webp" 
            alt="Tablo" 
            style={{ height: '20px', width: 'auto', objectFit: 'contain' }}
          />
          <span style={{ color: '#F2E8DF' }}>© 2026 Tablo</span>
        </div>
        <div style={{ color: '#F2E8DF', opacity: 0.7 }}>
          Voice-First AI Learning Assistant
        </div>
      </footer>
    </main>
    </LiveKitRoom>
  );
}
