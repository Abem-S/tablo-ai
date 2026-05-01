"use client";

import { HTMLContainer, ShapeUtil, TLShape, T, RecordProps, Geometry2d, Rectangle2d, TLResizeInfo, resizeBox } from "tldraw";

const SHAPE_SVG = "svg_shape";

declare module "tldraw" {
  export interface TLGlobalShapePropsMap {
    [SHAPE_SVG]: { w: number; h: number; svg: string; color: string };
  }
}

type ISvgShape = TLShape<typeof SHAPE_SVG>;

/**
 * Parse the bounding box of raw SVG content (elements without a wrapping <svg>).
 * Looks at coordinate attributes to figure out the actual content bounds.
 */
function inferViewBox(svgContent: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const xCoords: number[] = [];
  const yCoords: number[] = [];

  // polygon/polyline points="x1,y1 x2,y2 ..."
  for (const m of svgContent.matchAll(/points\s*=\s*["']([^"']+)["']/g)) {
    const vals = m[1].split(/[\s,]+/).map(parseFloat).filter(isFinite);
    for (let i = 0; i < vals.length; i += 2) {
      if (i + 1 < vals.length) { xCoords.push(vals[i]); yCoords.push(vals[i + 1]); }
    }
  }

  // circle/ellipse: cx, cy, r/rx/ry
  for (const m of svgContent.matchAll(/<(?:circle|ellipse)[^>]+>/g)) {
    const el = m[0];
    const cx = parseFloat((el.match(/\bcx\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    const cy = parseFloat((el.match(/\bcy\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    const rx = parseFloat((el.match(/\brx\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? (el.match(/\br\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "0");
    const ry = parseFloat((el.match(/\bry\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? (el.match(/\br\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "0");
    if (isFinite(cx) && isFinite(cy)) {
      xCoords.push(cx - rx, cx + rx);
      yCoords.push(cy - ry, cy + ry);
    }
  }

  // rect: x, y, width, height
  for (const m of svgContent.matchAll(/<rect[^>]+>/g)) {
    const el = m[0];
    const x = parseFloat((el.match(/\bx\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "0");
    const y = parseFloat((el.match(/\by\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "0");
    const w = parseFloat((el.match(/\bwidth\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "0");
    const h = parseFloat((el.match(/\bheight\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "0");
    if (isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h)) {
      xCoords.push(x, x + w);
      yCoords.push(y, y + h);
    }
  }

  // line: x1, y1, x2, y2
  for (const m of svgContent.matchAll(/<line[^>]+>/g)) {
    const el = m[0];
    const x1 = parseFloat((el.match(/\bx1\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    const y1 = parseFloat((el.match(/\by1\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    const x2 = parseFloat((el.match(/\bx2\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    const y2 = parseFloat((el.match(/\by2\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    if (isFinite(x1)) xCoords.push(x1);
    if (isFinite(y1)) yCoords.push(y1);
    if (isFinite(x2)) xCoords.push(x2);
    if (isFinite(y2)) yCoords.push(y2);
  }

  // path d: extract all numeric tokens (rough approximation)
  for (const m of svgContent.matchAll(/\bd\s*=\s*["']([^"']+)["']/g)) {
    const tokens = m[1].split(/[MmLlHhVvCcSsQqTtAaZz\s,]+/).map(parseFloat).filter(isFinite);
    // Alternate x/y (rough)
    for (let i = 0; i < tokens.length; i += 2) {
      xCoords.push(tokens[i]);
      if (i + 1 < tokens.length) yCoords.push(tokens[i + 1]);
    }
  }

  // text: x, y
  for (const m of svgContent.matchAll(/<text[^>]+>/g)) {
    const el = m[0];
    const x = parseFloat((el.match(/\bx\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    const y = parseFloat((el.match(/\by\s*=\s*["']?([\d.]+)/) ?? [])[1] ?? "NaN");
    if (isFinite(x)) xCoords.push(x);
    if (isFinite(y)) yCoords.push(y);
  }

  if (xCoords.length === 0 || yCoords.length === 0) return null;

  return {
    minX: Math.min(...xCoords),
    minY: Math.min(...yCoords),
    maxX: Math.max(...xCoords),
    maxY: Math.max(...yCoords),
  };
}

/**
 * Normalize SVG content for rendering:
 * - Wrap bare elements in <svg> if needed
 * - Compute correct viewBox from actual content bounds
 * - Strip fills (force outline-only style for whiteboard look)
 */
function normalizeSvg(svg: string, containerW: number, containerH: number): string {
  let content = svg.trim();

  // CSS style injection — forces outline style on all shapes
  const styleTag = `<style>rect,circle,ellipse,polygon,polyline,path,line{fill:none;stroke:black;stroke-width:2}</style>`;

  // Extract viewBox dimensions for repairing incomplete elements
  let vbW = containerW, vbH = containerH;

  // Handle full SVG document
  if (content.startsWith("<svg")) {
    const vbMatch = content.match(/viewBox\s*=\s*["']([^"']+)["']/);
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/).map(parseFloat);
      if (parts.length >= 4) { vbW = parts[2]; vbH = parts[3]; }

      // Repair <rect> elements missing width/height
      content = content.replace(/<rect([^/]*?)\/>/gi, (match, attrs) => {
        let fixed = attrs;
        if (!/\bwidth\s*=/.test(fixed)) fixed += ` width="${vbW * 0.8}"`;
        if (!/\bheight\s*=/.test(fixed)) fixed += ` height="${vbH * 0.8}"`;
        return `<rect${fixed}/>`;
      });

      // Strip width/height ONLY from the <svg> tag, not from child elements
      content = content.replace(/<svg([^>]*)>/, (match, attrs) => {
        const cleaned = attrs
          .replace(/\swidth\s*=\s*["'][^"']*["']/g, "")
          .replace(/\sheight\s*=\s*["'][^"']*["']/g, "")
          .replace(/\spreserveAspectRatio\s*=\s*["'][^"']*["']/g, "");
        return `<svg${cleaned} width="${containerW}" height="${containerH}">${styleTag}`;
      });
      return content;
    }
    // No viewBox — extract inner content
    const innerMatch = content.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
    if (innerMatch) content = innerMatch[1];
  }

  // Repair bare <rect> elements missing width/height
  content = content.replace(/<rect([^/]*?)\/>/gi, (match, attrs) => {
    let fixed = attrs;
    if (!/\bwidth\s*=/.test(fixed)) fixed += ` width="${containerW * 0.8}"`;
    if (!/\bheight\s*=/.test(fixed)) fixed += ` height="${containerH * 0.8}"`;
    return `<rect${fixed}/>`;
  });

  // Compute viewBox from content bounds
  const bounds = inferViewBox(content);
  let vb: string;
  if (bounds && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY) {
    const padX = Math.max((bounds.maxX - bounds.minX) * 0.08, 4);
    const padY = Math.max((bounds.maxY - bounds.minY) * 0.08, 4);
    vb = `${bounds.minX - padX} ${bounds.minY - padY} ${bounds.maxX - bounds.minX + padX * 2} ${bounds.maxY - bounds.minY + padY * 2}`;
  } else {
    vb = `0 0 ${containerW} ${containerH}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${containerW}" height="${containerH}">${styleTag}${content}</svg>`;
}

export class SvgShapeUtil extends ShapeUtil<ISvgShape> {
  static override type = SHAPE_SVG;
  static override props: RecordProps<ISvgShape> = {
    w: T.number,
    h: T.number,
    svg: T.string,
    color: T.string,
  };

  getDefaultProps(): ISvgShape["props"] {
    return { w: 200, h: 200, svg: "", color: "#1e293b" };
  }

  override canEdit() { return false; }
  override canResize() { return true; }
  override isAspectRatioLocked() { return false; }

  getGeometry(shape: ISvgShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false });
  }

  override onResize(shape: ISvgShape, info: TLResizeInfo<ISvgShape>) {
    return resizeBox(shape, info);
  }

  component(shape: ISvgShape) {
    const { w, h, svg } = shape.props;

    if (!svg) {
      return (
        <HTMLContainer style={{ width: w, height: h, display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed #ccc" }}>
          <span style={{ color: "#999", fontSize: 12 }}>No SVG</span>
        </HTMLContainer>
      );
    }

    const normalized = normalizeSvg(svg, w, h);
    console.log("[SvgShape] normalized:", normalized.substring(0, 200));

    return (
      <HTMLContainer style={{ width: w, height: h, overflow: "visible", backgroundColor: "transparent" }}>
        <div style={{ width: "100%", height: "100%" }} dangerouslySetInnerHTML={{ __html: normalized }} />
      </HTMLContainer>
    );
  }

  indicator(shape: ISvgShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }
}

export const svgShapeUtils = [SvgShapeUtil];
export const svgShapeType = SHAPE_SVG;
