'use strict';

var rbush = require('rbush'),
    rotationRange = require('./rotationrange.js'),
    Point = require('point-geometry');

module.exports = Collision;

function Collision(zoom, tileExtent, tileSize) {
    this.hTree = rbush(); // tree for horizontal labels
    this.cTree = rbush(); // tree for glyphs from curved labels

    // tile pixels per screen pixels at the tile's zoom level
    this.tilePixelRatio = tileExtent / tileSize;

    this.zoom = zoom - Math.log(256 / tileSize) / Math.LN2;

    // Calculate the maximum scale we can go down in our fake-3d rtree so that
    // placement still makes sense. This is calculated so that the minimum
    // placement zoom can be at most 25.5 (we use an unsigned integer x10 to
    // store the minimum zoom).
    //
    // We don't want to place labels all the way to 25.5. This lets too many
    // glyphs be placed, slowing down collision checking. Only place labels if
    // they will show up within the intended zoom range of the tile.
    // TODO make this not hardcoded to 3
    this.maxPlacementScale = Math.exp(Math.LN2 * Math.min((25.5 - this.zoom), 3)); 

    var m = 4096;
    var edge = m * this.tilePixelRatio * 2;
    // Hack to prevent cross-tile labels
    this.insert([{
        box: { x1: -edge, y1: -edge, x2: 0, y2: edge },
        padding: 2,
        minScale: 0
    }, {
        box: { x1: -edge, y1: -edge, x2: edge, y2: 0 },
        padding: 2,
        minScale: 0
    }], new Point(0, 0), 1, [Math.PI * 2, 0], false, 2);
    this.insert([{
        box: { x1: -edge, y1: 0, x2: edge, y2: edge },
        padding: 2,
        minScale: 0
    }, {
        box: { x1: 0, y1: -edge, x2: edge, y2: edge },
        padding: 2,
        minScale: 0
    }], new Point(m, m), 1, [Math.PI * 2, 0], false, 2);
}

Collision.prototype.getPlacementScale = function(glyphs, minPlacementScale) {

    for (var k = 0; k < glyphs.length; k++) {

        var glyph = glyphs[k];
        var box = glyph.box;
        var bbox = glyph.hBox || box;
        var anchor = glyph.anchor;
        var pad = glyph.padding;

        if (anchor.x < 0 || anchor.x > 4096 || anchor.y < 0 || anchor.y > 4096) return null;

        var minScale = Math.max(minPlacementScale, glyph.minScale);
        var maxScale = glyph.maxScale || Infinity;

        if (minScale >= maxScale) continue;

        // Compute the scaled bounding box of the unrotated glyph
        var searchBox = [
            anchor.x + bbox.x1 / minScale,
            anchor.y + bbox.y1 / minScale,
            anchor.x + bbox.x2 / minScale,
            anchor.y + bbox.y2 / minScale];

        var blocking = this.hTree.search(searchBox).concat(this.cTree.search(searchBox));

        if (blocking.length) {

            var na = anchor; // new anchor
            var nb = box; // new box

            for (var l = 0; l < blocking.length; l++) {
                var oa = blocking[l].anchor; // old anchor
                var ob = blocking[l].box; // old box

                // If anchors are identical, we're going to skip the label.
                // NOTE: this isn't right because there can be glyphs with
                // the same anchor but differing box offsets.
                if (na.equals(oa)) {
                    return null;
                }

                // todo: unhardcode the 8 = tileExtent/tileSize
                var padding = Math.max(pad, blocking[l].padding) * 8;

                // Original algorithm:
                var s1 = (ob.x1 - nb.x2 - padding) / (na.x - oa.x); // scale at which new box is to the left of old box
                var s2 = (ob.x2 - nb.x1 + padding) / (na.x - oa.x); // scale at which new box is to the right of old box
                var s3 = (ob.y1 - nb.y2 - padding) / (na.y - oa.y); // scale at which new box is to the top of old box
                var s4 = (ob.y2 - nb.y1 + padding) / (na.y - oa.y); // scale at which new box is to the bottom of old box

                if (isNaN(s1) || isNaN(s2)) s1 = s2 = 1;
                if (isNaN(s3) || isNaN(s4)) s3 = s4 = 1;

                var collisionFreeScale = Math.min(Math.max(s1, s2), Math.max(s3, s4));

                // Only update label's min scale if the glyph was restricted by a collision
                if (collisionFreeScale > minPlacementScale &&
                    collisionFreeScale > minScale &&
                    collisionFreeScale < maxScale &&
                    collisionFreeScale < blocking[l].maxScale) {
                    minPlacementScale = collisionFreeScale;
                }

                if (minPlacementScale > this.maxPlacementScale) {
                    return null;
                }
            }

        }
    }

    return minPlacementScale;
};

Collision.prototype.getPlacementRange = function(glyphs, placementScale, horizontal) {

    var placementRange = [2*Math.PI, 0];

    for (var k = 0; k < glyphs.length; k++) {
        var glyph = glyphs[k];
        var bbox = glyph.hBox || glyph.box;
        var anchor = glyph.anchor;

        var minPlacedX = anchor.x + bbox.x1 / placementScale;
        var minPlacedY = anchor.y + bbox.y1 / placementScale;
        var maxPlacedX = anchor.x + bbox.x2 / placementScale;
        var maxPlacedY = anchor.y + bbox.y2 / placementScale;

        var searchBox = [minPlacedX, minPlacedY, maxPlacedX, maxPlacedY];

        var blocking = this.hTree.search(searchBox);

        if (horizontal) {
            blocking = blocking.concat(this.cTree.search(searchBox));
        }

        for (var l = 0; l < blocking.length; l++) {
            var b = blocking[l];
            var bbox2 = b.hBox || b.box;

            var x1, x2, y1, y2, intersectX, intersectY;

            // Adjust and compare bboxes to see if the glyphs might intersect
            if (placementScale > b.placementScale) {
                x1 = b.anchor.x + bbox2.x1 / placementScale;
                y1 = b.anchor.y + bbox2.y1 / placementScale;
                x2 = b.anchor.x + bbox2.x2 / placementScale;
                y2 = b.anchor.y + bbox2.y2 / placementScale;
                intersectX = x1 < maxPlacedX && x2 > minPlacedX;
                intersectY = y1 < maxPlacedY && y2 > minPlacedY;
            } else {
                x1 = anchor.x + bbox.x1 / b.placementScale;
                y1 = anchor.y + bbox.y1 / b.placementScale;
                x2 = anchor.x + bbox.x2 / b.placementScale;
                y2 = anchor.y + bbox.y2 / b.placementScale;
                intersectX = x1 < b[2] && x2 > b[0];
                intersectY = y1 < b[3] && y2 > b[1];
            }

            // If they can't intersect, skip more expensive rotation calculation
            if (!(intersectX && intersectY)) continue;

            var scale = Math.max(placementScale, b.placementScale);
            var range = rotationRange.rotationRange(glyph, b, scale);

            placementRange[0] = Math.min(placementRange[0], range[0]);
            placementRange[1] = Math.max(placementRange[1], range[1]);
        }
    }

    return placementRange;

};

// Insert glyph placements into rtree.
Collision.prototype.insert = function(glyphs, anchor, placementScale, placementRange, horizontal) {

    var allBounds = [];

    for (var k = 0; k < glyphs.length; k++) {

        var glyph = glyphs[k];
        var bbox = glyph.hBox || glyph.box;

        var minScale = Math.max(placementScale, glyph.minScale);

        var bounds = [
            anchor.x + bbox.x1 / minScale,
            anchor.y + bbox.y1 / minScale,
            anchor.x + bbox.x2 / minScale,
            anchor.y + bbox.y2 / minScale
        ];

        bounds.anchor = anchor;
        bounds.box = glyph.box;
        if (glyph.hBox) {
            bounds.hBox = bbox;
        }
        bounds.placementRange = placementRange;
        bounds.placementScale = minScale;
        bounds.maxScale = glyph.maxScale || Infinity;
        bounds.padding = glyph.padding;

        allBounds.push(bounds);
    }

    (horizontal ? this.hTree : this.cTree).load(allBounds);
};
