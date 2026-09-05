/** The 3D light field evaluated on the flat map's ground plane. Coordinates
 * stay in world tiles; projecting the source onto a sprite is only for handles. */
class FlatLightField2D {
    static source(light) {
        return light.shadowSource || { x: light.x + 0.5, y: light.height || 0, z: light.y + 1 };
    }

    static aim(light) {
        const yaw = -(light.yaw || 0) * Math.PI / 180, pitch = (light.pitch || 0) * Math.PI / 180;
        return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
    }

    /** Conservative footprint, clipped to the range sphere and map. For a
     * downward cone its plane intersection is an ellipse, not a sideways fan. */
    static bounds(light, map, stable = false) {
        const source = this.source(light), radius = stable ? (light.priorityRadius ?? light.radius) : light.radius;
        if (!(radius > Math.abs(source.y))) return null;
        const reach = Math.sqrt(radius * radius - source.y * source.y);
        let minX = source.x - reach, maxX = source.x + reach, minY = source.z - reach, maxY = source.z + reach;
        if (light.type !== 'point') {
            const aim = this.aim(light), horizontal = Math.hypot(aim.x, aim.z);
            const half = Math.min(light.angle ?? 45, 178) * Math.PI / 360;
            if (light.type === 'beam') {
                if (source.y >= (light.width ?? 0.08) / 2 && aim.y >= 0) return null;
            } else if (source.y > 0 && aim.y >= Math.sin(half)) return null;
            const c = Math.cos(half), denom = c * c - horizontal * horizontal;
            let along, across, center;
            if (light.type === 'beam' && aim.y < -0.001) {
                across = (light.width ?? 0.08) / 2;
                along = across / -aim.y;
                center = source.y * horizontal / -aim.y;
            } else if (light.type === 'spot' && aim.y < 0 && denom > 0.00001) {
                across = source.y * Math.sin(half) / Math.sqrt(denom);
                along = source.y * c * Math.sin(half) / denom;
                center = source.y * -aim.y * horizontal / denom;
            }
            if (along !== undefined) {
                const dx = horizontal > 0.00001 ? aim.x / horizontal : 1;
                const dz = horizontal > 0.00001 ? aim.z / horizontal : 0;
                const x = source.x + dx * center, z = source.z + dz * center;
                const ex = Math.hypot(along * dx, across * dz), ez = Math.hypot(along * dz, across * dx);
                minX = Math.max(minX, x - ex); maxX = Math.min(maxX, x + ex);
                minY = Math.max(minY, z - ez); maxY = Math.min(maxY, z + ez);
            }
        }
        minX = Math.max(0, minX); minY = Math.max(0, minY);
        maxX = Math.min(map.width, maxX); maxY = Math.min(map.height, maxY);
        return maxX > minX && maxY > minY ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
    }
}
if (typeof module !== 'undefined' && module.exports) module.exports = FlatLightField2D;
