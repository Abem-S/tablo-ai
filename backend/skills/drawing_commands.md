# Drawing Commands Reference

All drawing goes through `execute_command` with a JSON string. Always check the board first with `get_board_state`.

## Board State

```json
{"op":"get_board_state"}
```
Returns all shape IDs, types, bounds, labels. Call this before drawing to find empty space and existing shape IDs.

Use `get_board_image` (a separate tool) when you need to SEE the board visually — to read handwritten text, check student drawings, or understand freehand content that get_board_state can't describe.

## Text

```json
{"op":"create_text","text":"a² + b² = c²","x":100,"y":100}
{"op":"create_formula","formula":"\\frac{d}{dx}x^n = nx^{n-1}","x":100,"y":100}
{"op":"create_multiline_text","lines":["Step 1: identify the hypotenuse","Step 2: label sides a, b, c"],"x":50,"y":50}
```

## Geometry

```json
{"op":"create_geo","geo":"rectangle","x":100,"y":100,"w":120,"h":80,"label":"Router"}
{"op":"create_geo","geo":"ellipse","x":200,"y":200,"w":100,"h":100}
{"op":"create_geo","geo":"diamond","x":300,"y":100,"w":100,"h":80,"label":"Decision"}
{"op":"create_arrow","x":100,"y":100,"toX":300,"toY":100}
{"op":"create_arrow_between_targets","from":{"kind":"shape_id","shapeId":"shape:abc"},"to":{"kind":"shape_id","shapeId":"shape:xyz"},"label":"sends to"}
```

## Math Graphs (frontend evaluates — always accurate)

```json
{"op":"create_graph","expressions":[{"expr":"sin(x)","label":"sin(x)"},{"expr":"cos(x)","label":"cos(x)"}],"x":50,"y":50,"xMin":-6.28,"xMax":6.28}
{"op":"create_graph","expressions":[{"expr":"x^2 - 4"}],"x":50,"y":50,"xMin":-4,"xMax":4}
```
Expression syntax: `sin(x)`, `cos(x)`, `tan(x)`, `x^2`, `sqrt(x)`, `log(x)`, `exp(x)`, `abs(x)`, `pi`, `e`

**Use `create_graph` for any y=f(x) function** — it evaluates accurately on the frontend.
**Use `create_svg` for custom graphs** (supply/demand, indifference curves, Bode plots) — draw them as simple SVG lines, not complex paths. Supply/demand example: two straight diagonal lines crossing, labeled D and S.

## Parametric Graphs

```json
{"op":"create_parametric_graph","exprX":"cos(t)","exprY":"sin(t)","tMin":0,"tMax":6.28,"label":"unit circle","x":50,"y":50}
{"op":"create_parametric_graph","exprX":"t*cos(t)","exprY":"t*sin(t)","tMin":0,"tMax":12.56,"label":"spiral","x":50,"y":50}
```

## Regular Polygons

```json
{"op":"create_polygon","sides":5,"x":200,"y":200,"radius":80}
{"op":"create_polygon","sides":6,"x":200,"y":200,"radius":80}
{"op":"create_polygon","sides":5,"x":200,"y":200,"radius":80,"star":true}
```

## SVG Shapes (CRITICAL RULES)

- Always `fill='none'` and `stroke='black'` `stroke-width='2'`
- `viewBox` must match your coordinate space
- For `<rect>` ALWAYS include `x`, `y`, `width`, AND `height`
- **Keep SVG concise** — avoid complex path data. If an SVG would need more than 5-6 elements, use multiple simpler commands instead
- **For pie charts** — use `create_geo` ellipses with `create_text` labels, not SVG arc paths
- **For bar charts** — use multiple `create_geo` rectangles with `create_text` labels

```json
{"op":"create_svg","svg":"<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":150,"h":150}
{"op":"create_svg","svg":"<svg viewBox='0 0 100 60'><rect x='5' y='5' width='90' height='50' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":200,"h":120}
{"op":"create_svg","svg":"<svg viewBox='0 0 100 100'><polygon points='50,5 95,95 5,95' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":150,"h":150}
{"op":"create_svg","svg":"<svg viewBox='0 0 100 100'><polygon points='5,95 95,95 5,5' fill='none' stroke='black' stroke-width='2'/><rect x='5' y='85' width='10' height='10' fill='none' stroke='black' stroke-width='1.5'/></svg>","x":100,"y":100,"w":150,"h":150}
{"op":"create_svg","svg":"<svg viewBox='0 0 120 100'><polygon points='60,10 100,30 100,70 60,90 20,70 20,30' fill='none' stroke='black' stroke-width='2'/><line x1='60' y1='10' x2='60' y2='50' stroke='black' stroke-width='2'/><line x1='20' y1='30' x2='60' y2='50' stroke='black' stroke-width='2'/><line x1='100' y1='30' x2='60' y2='50' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":180,"h":150}
```

## Mutating Existing Shapes

```json
{"op":"update_shape","shapeId":"shape:abc123","label":"new label"}
{"op":"update_shape","shapeId":"shape:abc123","x":200,"y":100,"w":150,"h":80}
{"op":"update_shape","shapeId":"shape:abc123","color":"blue"}
{"op":"delete_shape","shapeId":"shape:abc123"}
{"op":"undo"}
{"op":"clear_board"}
```

## Positioning Helpers

```json
{"op":"get_position_info","query":"empty_regions"}
{"op":"suggest_placement","preferredRegion":"right"}
{"op":"calculate_position","sourceShapeId":"shape:abc","relativeTo":"right","offset":50}
```
