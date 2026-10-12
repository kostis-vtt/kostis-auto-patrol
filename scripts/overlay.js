// What the planner shows on the map: the floor the scan found, rooms and doorways, proposed walls, painted hints
// and every patrol's route. Drawn into the hub layer's overlay for this module.

import {ANIMATOR_ID, FLAG_HINTS, HUB_ID, MODULE_ID} from "./const.js";
import {Scanner} from "./scanner.js";
import {Patroller} from "./patroller.js";
import {STRATEGIES} from "./patrols.js";

const ROOM_COLORS = [[63, 167, 255], [61, 220, 132], [247, 140, 64], [197, 108, 240], [255, 93, 108], [242, 193, 78], [46, 211, 198], [154, 160, 255]];

export class Overlay {
  /** What to draw. */
  static show = {mask: true, rooms: false, walls: true, routes: true, hints: true};

  /** Drawn only while planning. */
  static enabled = false;

  static #cache = {key: null, mask: null, rooms: null};

  static get root() {
    return game.modules.get(HUB_ID)?.api?.layer?.overlay(MODULE_ID) ?? null;
  }

  static clear() {
    const root = this.root;
    if ( root ) for ( const c of root.removeChildren() ) c.destroy({children: true});
  }

  static draw() {
    const root = this.root;
    if ( !root ) return;
    this.clear();
    if ( !this.enabled || !canvas.ready ) return;
    const r = Scanner.current;
    const scene = canvas.scene;
    const grid = scene.dimensions.size;
    if ( r ) {
      const key = `${r.sceneId}:${r.at}:${r.rev ?? 0}`;
      if ( this.#cache.key !== key ) {
        this.#cache.mask?.destroy(true);
        this.#cache.rooms?.destroy(true);
        this.#cache = {key, mask: this.#maskTexture(r), rooms: this.#roomTexture(r)};
      }
      if ( this.show.mask ) {
        const s = root.addChild(new PIXI.Sprite(this.#cache.mask));
        s.position.set(r.image.sceneX, r.image.sceneY);
        s.width = (r.vision.W / r.image.S) * r.image.grid;
        s.height = (r.vision.H / r.image.S) * r.image.grid;
      }
      if ( this.show.rooms ) {
        const s = root.addChild(new PIXI.Sprite(this.#cache.rooms));
        s.position.set(r.nav.x, r.nav.y);
        s.width = r.nav.cols * r.nav.cell;
        s.height = r.nav.rows * r.nav.cell;
        const g = root.addChild(new PIXI.Graphics());
        for ( const d of r.rooms.doorways ) {
          g.lineStyle(3, 0x000000, 0.8).beginFill(0xffffff, 0.95).drawCircle(d.point.x, d.point.y, grid * 0.14).endFill();
        }
      }
      if ( this.show.walls && r.proposed.length ) {
        const g = root.addChild(new PIXI.Graphics());
        g.lineStyle({width: Math.max(3, grid * 0.05), color: 0xffe14d, alpha: 0.95, cap: PIXI.LINE_CAP.ROUND});
        for ( const [x0, y0, x1, y1] of r.proposed ) {
          g.moveTo(x0, y0);
          g.lineTo(x1, y1);
        }
        g.lineStyle(0);
        for ( const [x0, y0] of r.proposed ) g.beginFill(0xffe14d, 1).drawCircle(x0, y0, grid * 0.05).endFill();
      }
    }
    if ( this.show.hints ) {
      const hints = scene.getFlag(MODULE_ID, FLAG_HINTS) ?? {};
      const g = root.addChild(new PIXI.Graphics());
      for ( const p of hints.floor ?? [] ) g.beginFill(0x3ddc84, 0.75).drawCircle(p.x, p.y, grid * 0.12).endFill();
      for ( const p of hints.wall ?? [] ) g.beginFill(0xff5d6c, 0.75).drawRect(p.x - (grid * 0.11), p.y - (grid * 0.11), grid * 0.22, grid * 0.22).endFill();
    }
    if ( this.show.routes ) this.#drawRoutes(root, grid);
  }

  static #maskTexture(r) {
    const {W, H, mask} = r.vision;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    for ( let i = 0, j = 0; i < W * H; i++, j += 4 ) {
      if ( mask[i] ) {
        img.data[j] = 61; img.data[j + 1] = 220; img.data[j + 2] = 132; img.data[j + 3] = 55;
      } else {
        img.data[j] = 255; img.data[j + 1] = 60; img.data[j + 2] = 70; img.data[j + 3] = 95;
      }
    }
    ctx.putImageData(img, 0, 0);
    return PIXI.Texture.from(cv);
  }

  static #roomTexture(r) {
    const {cols, rows} = r.nav;
    const cv = document.createElement("canvas");
    cv.width = cols;
    cv.height = rows;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(cols, rows);
    for ( let i = 0, j = 0; i < cols * rows; i++, j += 4 ) {
      const id = r.rooms.roomOf[i];
      if ( id < 0 ) continue;
      const c = ROOM_COLORS[id % ROOM_COLORS.length];
      img.data[j] = c[0]; img.data[j + 1] = c[1]; img.data[j + 2] = c[2]; img.data[j + 3] = 80;
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(cv);
    tex.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
    return tex;
  }

  static #drawRoutes(root, grid) {
    const api = game.modules.get(ANIMATOR_ID)?.active ? game.modules.get(ANIMATOR_ID).api : null;
    const build = api?.internals?.buildShape;
    if ( !build ) return;
    const g = root.addChild(new PIXI.Graphics());
    for ( const p of Patroller.list() ) {
      const anim = api.getAnimation(p.animId);
      if ( !anim ) continue;
      const color = Number(foundry.utils.Color.from(STRATEGIES[p.strategy]?.color ?? anim.color));
      for ( const st of anim.steps ) {
        if ( st.shape.type === "point" ) {
          g.lineStyle(3, color, 0.9).drawCircle(st.shape.x, st.shape.y, grid * 0.35);
          continue;
        }
        const lut = build(st.shape).lut;
        // Dashed line along the route
        const dash = grid * 0.18;
        g.lineStyle({width: Math.max(2, grid * 0.04), color, alpha: 0.9});
        for ( let d = 0; d < lut.length; d += dash * 1.8 ) {
          const a = lut.pointAt(d);
          const b = lut.pointAt(Math.min(lut.length, d + dash));
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
        if ( st.wait > 0 ) {
          const e = lut.pointAt(lut.length);
          g.lineStyle(0).beginFill(color, 0.9).drawCircle(e.x, e.y, grid * 0.09).endFill();
        }
      }
    }
  }
}
