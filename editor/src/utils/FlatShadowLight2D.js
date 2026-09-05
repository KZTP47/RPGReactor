/** A shadow masks only its own additive light. Other lights can fill it and
 * ambient remains intact. One mask sample replaces a dark overlay/filter pass. */
class FlatShadowLight2D extends PIXI.Mesh {
    constructor(texture, shadow = PIXI.Texture.EMPTY) {
        const shader = new PIXI.Shader({
            glProgram: PIXI.GlProgram.from({
                vertex: `
                    in vec2 aPosition; in vec2 aUV;
                    uniform mat3 uProjectionMatrix, uWorldTransformMatrix, uTransformMatrix;
                    uniform vec4 uWorldColorAlpha, uColor;
                    out vec2 vUV; out vec4 vColor;
                    void main() {
                        vec3 p = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
                        gl_Position = vec4(p.xy, 0.0, 1.0);
                        vUV = aUV;
                        vColor = uWorldColorAlpha * uColor;
                    }`,
                fragment: `
                    precision highp float;
                    in vec2 vUV; in vec4 vColor;
                    uniform sampler2D uShadow;
                    uniform vec4 uSource, uAim, uBounds, uShadowBounds;
                    uniform float uShape, uHasShadow;
                    out vec4 finalColor;
                    void main() {
                        vec2 ground = uBounds.xy + vUV * uBounds.zw;
                        vec3 d = vec3(ground.x, 0.0, ground.y) - uSource.xyz;
                        float dist = length(d);
                        float fall = max(0.0, 1.0 - dist / max(uSource.w, 0.001));
                        fall *= fall;
                        if (uShape > 1.5) {
                            float t = dot(d, uAim.xyz);
                            float perp = length(d - uAim.xyz * t);
                            fall = (1.0 - smoothstep(uAim.w * 0.35, uAim.w, perp)) * sqrt(max(0.0, 1.0 - t / max(uSource.w, 0.001)));
                            if (t < 0.0 || t > uSource.w || dist >= uSource.w) fall = 0.0;
                        } else if (uShape > 0.5) {
                            float c = dot(d / max(dist, 0.0001), uAim.xyz);
                            fall *= smoothstep(uAim.w, mix(uAim.w, 1.0, 0.35), c);
                        }
                        vec2 shadowUV = (ground - uShadowBounds.xy) / uShadowBounds.zw;
                        float cover = 0.0;
                        if (uHasShadow > 0.5 && shadowUV.x >= 0.0 && shadowUV.x <= 1.0 && shadowUV.y >= 0.0 && shadowUV.y <= 1.0)
                            cover = texture(uShadow, vec2(shadowUV.x, 1.0 - shadowUV.y)).a;
                        finalColor = vColor * (fall * (1.0 - cover));
                    }`
            }),
            resources: { uShadow: shadow.source,
                lightUniforms: {
                    uSource: { value: new Float32Array(4), type: 'vec4<f32>' },
                    uAim: { value: new Float32Array(4), type: 'vec4<f32>' },
                    uBounds: { value: new Float32Array(4), type: 'vec4<f32>' },
                    uShadowBounds: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
                    uShape: { value: 0, type: 'f32' }, uHasShadow: { value: 0, type: 'f32' }
                } }
        });
        super({ geometry: new PIXI.MeshGeometry({ positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }), shader, texture });
        this.anchor = this.pivot;
        this._flatShadow = true;
    }

    syncLight(light, bounds, shadow, tw) {
        const source = FlatLightField2D.source(light), aim = FlatLightField2D.aim(light);
        const u = this.shader.resources.lightUniforms.uniforms;
        u.uSource.set([source.x, source.y, source.z, light.radius]);
        u.uAim.set([aim.x, aim.y, aim.z, light.type === 'beam' ? (light.width ?? 0.08) / 2 : Math.cos(Math.min(light.angle ?? 45, 178) * Math.PI / 360)]);
        u.uShape = light.type === 'beam' ? 2 : light.type === 'spot' ? 1 : 0;
        u.uBounds.set([bounds.x, bounds.y, bounds.width, bounds.height]);
        u.uHasShadow = shadow?.texture && !shadow.empty ? 1 : 0;
        this.shader.resources.uShadow = (shadow?.texture || PIXI.Texture.EMPTY).source;
        if (shadow?.bounds) u.uShadowBounds.set([shadow.bounds.x, shadow.bounds.y, shadow.bounds.width, shadow.bounds.height]);
        this.position.set(bounds.x * tw, bounds.y * tw);
        this.width = bounds.width * tw; this.height = bounds.height * tw;
    }

    destroy(options) {
        const geometry = this.geometry, shader = this.shader;
        super.destroy(options);
        geometry.destroy(); shader.destroy();
    }
}
