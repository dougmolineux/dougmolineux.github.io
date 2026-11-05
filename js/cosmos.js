// 3D solar-system backdrop for the homepage.
// The camera flies between planets as the page scrolls: every element with a
// data-cam attribute is a "shot", and scroll position blends between them.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const canvas = document.getElementById('space');
const root = document.documentElement;

let renderer = null;
try {
    renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: !matchMedia('(pointer: coarse)').matches,
        powerPreference: 'high-performance',
    });
} catch (err) {
    root.classList.add('no-webgl');
}
if (renderer) start(renderer);

function start(renderer) {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = matchMedia('(hover: none), (pointer: coarse)').matches;
    const lowPower = coarse || (navigator.hardwareConcurrency || 8) <= 4;

    let dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x04050d, 1);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    const V3 = THREE.Vector3;

    const rand = (a, b) => a + Math.random() * (b - a);
    const gauss = () => {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    // ---------- Shared GLSL ----------
    const OCTAVES = lowPower ? 4 : 5;
    const NOISE = /* glsl */ `
        vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
        vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
        float snoise(vec3 v){
            const vec2 C=vec2(1.0/6.0,1.0/3.0);
            const vec4 D=vec4(0.0,0.5,1.0,2.0);
            vec3 i=floor(v+dot(v,C.yyy));
            vec3 x0=v-i+dot(i,C.xxx);
            vec3 g=step(x0.yzx,x0.xyz);
            vec3 l=1.0-g;
            vec3 i1=min(g.xyz,l.zxy);
            vec3 i2=max(g.xyz,l.zxy);
            vec3 x1=x0-i1+C.xxx;
            vec3 x2=x0-i2+C.yyy;
            vec3 x3=x0-D.yyy;
            i=mod289(i);
            vec4 p=permute(permute(permute(
                i.z+vec4(0.0,i1.z,i2.z,1.0))
                +i.y+vec4(0.0,i1.y,i2.y,1.0))
                +i.x+vec4(0.0,i1.x,i2.x,1.0));
            float n_=0.142857142857;
            vec3 ns=n_*D.wyz-D.xzx;
            vec4 j=p-49.0*floor(p*ns.z*ns.z);
            vec4 x_=floor(j*ns.z);
            vec4 y_=floor(j-7.0*x_);
            vec4 x=x_*ns.x+ns.yyyy;
            vec4 y=y_*ns.x+ns.yyyy;
            vec4 h=1.0-abs(x)-abs(y);
            vec4 b0=vec4(x.xy,y.xy);
            vec4 b1=vec4(x.zw,y.zw);
            vec4 s0=floor(b0)*2.0+1.0;
            vec4 s1=floor(b1)*2.0+1.0;
            vec4 sh=-step(h,vec4(0.0));
            vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
            vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
            vec3 p0=vec3(a0.xy,h.x);
            vec3 p1=vec3(a0.zw,h.y);
            vec3 p2=vec3(a1.xy,h.z);
            vec3 p3=vec3(a1.zw,h.w);
            vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
            p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
            vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
            m=m*m;
            return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
        }
        float fbm(vec3 p){
            float f=0.0,a=0.5;
            for(int i=0;i<${OCTAVES};i++){f+=a*snoise(p);p=p*2.03+vec3(1.7,-3.1,2.3);a*=0.5;}
            return f;
        }
    `;

    const SPHERE_VS = /* glsl */ `
        varying vec3 vObj; varying vec3 vN; varying vec3 vW;
        void main(){
            vObj = normalize(position);
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
        }
    `;

    // Sun sits at the origin, so the light direction is just -worldPos.
    const PLANET_FS = /* glsl */ `
        uniform float uTime, uType, uSeed;
        uniform vec3 uA, uB, uC, uD, uAtmo;
        varying vec3 vObj; varying vec3 vN; varying vec3 vW;
        ${NOISE}
        void main(){
            vec3 p = vObj + uSeed;
            vec3 N = normalize(vN);
            vec3 L = normalize(-vW);
            vec3 V = normalize(cameraPosition - vW);
            float ndl = dot(N, L);
            vec3 col; float spec = 0.0; vec3 emit = vec3(0.0);

            if (uType < 0.5) {            // rocky
                float n = fbm(p * 2.5);
                float r = 1.0 - abs(snoise(p * 7.0));
                col = mix(uA, uB, smoothstep(-0.45, 0.55, n));
                col = mix(col, uC, pow(r, 6.0) * 0.55);
            } else if (uType < 1.5) {     // ocean world
                float n = fbm(p * 1.8);
                float land = smoothstep(0.04, 0.1, n);
                vec3 ocean = mix(uA * 0.45, uA, smoothstep(-0.6, 0.06, n));
                float m = fbm(p * 5.0 + 4.0);
                vec3 ground = mix(uB, uC, smoothstep(-0.2, 0.45, m + n * 0.6));
                col = mix(ocean, ground, land);
                float ice = smoothstep(0.74, 0.86, abs(vObj.y) + n * 0.12);
                col = mix(col, vec3(0.92, 0.95, 1.0), ice);
                float clouds = smoothstep(0.05, 0.55, fbm(p * 2.6 + vec3(uTime * 0.015, 0.0, uTime * 0.01) + 9.0));
                float city = smoothstep(0.62, 0.9, snoise(p * 38.0)) * land * (1.0 - ice);
                emit = vec3(1.0, 0.62, 0.25) * city * smoothstep(0.05, -0.25, ndl) * (1.0 - clouds) * 1.4;
                col = mix(col, vec3(1.0), clouds * 0.85);
                spec = (1.0 - land) * (1.0 - clouds) * (1.0 - ice);
            } else if (uType < 2.5) {     // banded gas giant
                float t = fbm(p * vec3(1.6, 5.0, 1.6) + vec3(uTime * 0.02, 0.0, 0.0)) * 0.22;
                float y = vObj.y + t;
                col = mix(uA, uB, sin(y * 16.0) * 0.5 + 0.5);
                col = mix(col, uC, (sin(y * 6.0 + 1.7) * 0.5 + 0.5) * 0.55);
                float sd = distance(vObj, normalize(vec3(0.55, -0.32, 0.77)));
                col = mix(col, uD, smoothstep(0.2, 0.06, sd + t * 0.4) * 0.85);
            } else {                      // ice giant
                float t = fbm(p * 2.4 + vec3(uTime * 0.012, 0.0, 0.0)) * 0.14;
                float y = vObj.y + t;
                col = mix(uA, uB, (sin(y * 9.0) * 0.5 + 0.5) * 0.6 + fbm(p * 3.2) * 0.25);
                col = mix(col, uC, smoothstep(0.7, 0.95, abs(vObj.y)) * 0.6);
            }

            float diff = smoothstep(-0.12, 0.65, ndl);
            vec3 lit = col * (0.025 + diff * 1.15);
            vec3 H = normalize(L + V);
            lit += vec3(1.0, 0.9, 0.75) * pow(max(dot(N, H), 0.0), 48.0) * spec * 0.7 * diff;
            float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
            lit += uAtmo * fres * smoothstep(-0.25, 0.5, ndl) * 0.9;
            lit += emit;
            gl_FragColor = vec4(lit, 1.0);
            #include <colorspace_fragment>
        }
    `;

    const SUN_FS = /* glsl */ `
        uniform float uTime;
        varying vec3 vObj; varying vec3 vN; varying vec3 vW;
        ${NOISE}
        void main(){
            vec3 p = vObj;
            float n = fbm(p * 4.0 + vec3(0.0, uTime * 0.05, uTime * 0.03));
            float n2 = fbm(p * 12.0 - vec3(uTime * 0.08));
            float heat = 0.55 + 0.35 * n + 0.15 * n2;
            vec3 col = mix(vec3(1.0, 0.32, 0.04), vec3(1.0, 0.72, 0.28), smoothstep(0.2, 0.8, heat));
            col = mix(col, vec3(1.0, 0.97, 0.86), smoothstep(0.75, 1.0, heat));
            float mu = max(dot(normalize(vN), normalize(cameraPosition - vW)), 0.0);
            col *= (0.55 + 0.45 * pow(mu, 0.5)) * 1.6;
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
        }
    `;

    // Back-face shell: bright where it hugs the planet, fading to nothing at its rim,
    // and only on the sun-facing side.
    const ATMO_FS = /* glsl */ `
        uniform vec3 uColor; uniform float uEdge, uIntensity;
        varying vec3 vObj; varying vec3 vN; varying vec3 vW;
        void main(){
            vec3 N = normalize(vN);
            vec3 V = normalize(cameraPosition - vW);
            float glow = pow(smoothstep(0.0, uEdge, -dot(N, V)), 1.5);
            float lit = smoothstep(-0.35, 0.5, dot(N, normalize(-vW)));
            float a = glow * lit * uIntensity;
            gl_FragColor = vec4(uColor * a, a);
            #include <colorspace_fragment>
        }
    `;

    const RING_VS = /* glsl */ `
        varying vec2 vLocal; varying vec3 vW;
        void main(){
            vLocal = position.xy;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
        }
    `;
    const RING_FS = /* glsl */ `
        uniform float uInner, uOuter, uPlanetR;
        uniform vec3 uA, uB, uPlanetPos;
        varying vec2 vLocal; varying vec3 vW;
        ${NOISE}
        void main(){
            float x = (length(vLocal) - uInner) / (uOuter - uInner);
            float bands = 0.55 + 0.45 * sin(x * 60.0 + snoise(vec3(x * 12.0, 0.0, 0.0)) * 2.0);
            bands *= 0.6 + 0.4 * snoise(vec3(x * 30.0, 1.0, 2.0));
            float gap = smoothstep(0.0, 0.02, abs(x - 0.62) - 0.03);
            float alpha = clamp(bands * gap * smoothstep(0.0, 0.05, x) * smoothstep(1.0, 0.9, x), 0.0, 1.0) * 0.85;
            vec3 col = mix(uA, uB, clamp(x + 0.2 * snoise(vec3(x * 20.0, 3.0, 0.0)), 0.0, 1.0));
            // Planet's shadow across the ring: does the ray toward the sun hit the planet?
            vec3 toSun = normalize(-vW);
            vec3 oc = vW - uPlanetPos;
            float b = dot(oc, toSun);
            float h = b * b - (dot(oc, oc) - uPlanetR * uPlanetR);
            col *= (h > 0.0 && b < 0.0) ? 0.1 : 1.1;
            gl_FragColor = vec4(col, alpha);
            #include <colorspace_fragment>
        }
    `;

    // ---------- Sun ----------
    const timeUniform = { value: 0 };
    const segs = lowPower ? 48 : 72;

    const sunMat = new THREE.ShaderMaterial({ uniforms: { uTime: timeUniform }, vertexShader: SPHERE_VS, fragmentShader: SUN_FS });
    const sun = new THREE.Mesh(new THREE.SphereGeometry(6, segs, segs * 0.75), sunMat);
    sun.userData = { label: 'Sol', section: '#home' };
    scene.add(sun);

    function radialTexture(stops) {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, 256, 256);
        const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
        stops.forEach(([o, col]) => grad.addColorStop(o, col));
        g.fillStyle = grad;
        g.fillRect(0, 0, 256, 256);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }
    const glowTex = radialTexture([
        [0, 'rgb(255,244,214)'],
        [0.18, 'rgb(191,147,82)'],
        [0.42, 'rgb(46,22,9)'],
        [1, 'rgb(0,0,0)'],
    ]);
    const addGlow = (scale, opacity, color) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTex, color, opacity, transparent: true,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        s.scale.set(scale, scale, 1);
        scene.add(s);
    };
    addGlow(44, 1, 0xffffff);
    addGlow(130, 0.35, 0xff8a4a);

    scene.add(new THREE.PointLight(0xfff1e0, 2.4, 0, 0));
    scene.add(new THREE.AmbientLight(0x6070a0, 0.25));

    // ---------- Planets ----------
    const orbitMat = new THREE.LineBasicMaterial({ color: 0x8fb0ff, transparent: true, opacity: 0.12, depthWrite: false });
    function orbitLine(r) {
        const pts = [];
        for (let i = 0; i <= 256; i++) {
            const a = (i / 256) * Math.PI * 2;
            pts.push(new V3(Math.cos(a) * r, 0, Math.sin(a) * r));
        }
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat));
    }

    const bodies = [];
    function makePlanet(o) {
        const pivot = new THREE.Group();
        const tilt = new THREE.Group();
        tilt.rotation.z = o.tilt || 0;
        pivot.add(tilt);
        scene.add(pivot);

        const col = (i) => new THREE.Color(o.colors[i] || o.colors[0]);
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uTime: timeUniform, uType: { value: o.type }, uSeed: { value: o.seed || 0 },
                uA: { value: col(0) }, uB: { value: col(1) }, uC: { value: col(2) }, uD: { value: col(3) },
                uAtmo: { value: new THREE.Color(o.atmo || '#000000') },
            },
            vertexShader: SPHERE_VS, fragmentShader: PLANET_FS,
        });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(o.radius, segs, segs * 0.75), mat);
        mesh.userData = { label: o.label, section: o.section };
        tilt.add(mesh);

        if (o.atmo) {
            const s = 1.14;
            const shell = new THREE.Mesh(
                new THREE.SphereGeometry(o.radius * s, 48, 32),
                new THREE.ShaderMaterial({
                    uniforms: {
                        uColor: { value: new THREE.Color(o.atmo) },
                        uEdge: { value: Math.sqrt(1 - 1 / (s * s)) },
                        uIntensity: { value: o.atmoStrength ?? 1 },
                    },
                    vertexShader: SPHERE_VS, fragmentShader: ATMO_FS,
                    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
                }),
            );
            tilt.add(shell);
        }

        let ringMat = null;
        if (o.ring) {
            const inner = o.radius * o.ring.inner, outer = o.radius * o.ring.outer;
            ringMat = new THREE.ShaderMaterial({
                uniforms: {
                    uInner: { value: inner }, uOuter: { value: outer }, uPlanetR: { value: o.radius },
                    uA: { value: new THREE.Color(o.ring.colors[0]) }, uB: { value: new THREE.Color(o.ring.colors[1]) },
                    uPlanetPos: { value: pivot.position },
                },
                vertexShader: RING_VS, fragmentShader: RING_FS,
                side: THREE.DoubleSide, transparent: true, depthWrite: false,
            });
            const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 160, 1), ringMat);
            ring.rotation.x = -Math.PI / 2;
            tilt.add(ring);
        }

        if (!o.parent) orbitLine(o.orbit);

        const body = {
            ...o, pivot, mesh,
            update(t) {
                const a = o.phase + t * o.speed;
                const c = o.parent ? o.parent.pivot.position : null;
                pivot.position.set(Math.cos(a) * o.orbit, o.parent ? Math.sin(a) * 0.6 : 0, Math.sin(a) * o.orbit);
                if (c) pivot.position.add(c);
                mesh.rotation.y = t * o.spin;
            },
        };
        bodies.push(body);
        return body;
    }

    const ember = makePlanet({
        label: 'Ember', section: '#contact', type: 0, radius: 1.3, orbit: 14, speed: 0.045, phase: 4.0, spin: 0.1, seed: 3.1,
        colors: ['#4a2418', '#c46a3a', '#f3c08a'], atmo: '#ff8a4c', atmoStrength: 0.4,
    });
    const terra = makePlanet({
        label: 'Terra', section: '#about', type: 1, radius: 2.4, orbit: 24, speed: 0.022, phase: 1.9, spin: 0.06, tilt: 0.41, seed: 7.3,
        colors: ['#1f5fae', '#3f6b35', '#b59a68'], atmo: '#5fa8ff', atmoStrength: 1.1,
    });
    makePlanet({
        label: 'Luna', section: '#about', type: 0, radius: 0.55, orbit: 4.4, speed: 0.18, phase: 0.6, spin: 0.05, seed: 11.0,
        colors: ['#55555b', '#a3a3a8', '#dadade'], parent: terra,
    });
    const kronos = makePlanet({
        label: 'Kronos', section: '#expertise', type: 2, radius: 5.2, orbit: 52, speed: 0.011, phase: 0.3, spin: 0.12, tilt: 0.45, seed: 2.0,
        colors: ['#d9b98a', '#a8774a', '#f2e3c4', '#c0603a'], atmo: '#f3c98b', atmoStrength: 0.7,
        ring: { inner: 1.35, outer: 2.35, colors: ['#d8c29b', '#7d6a52'] },
    });
    const thalassa = makePlanet({
        label: 'Thalassa', section: '#projects', type: 3, radius: 3.6, orbit: 72, speed: 0.007, phase: -0.6, spin: 0.05, tilt: 0.2, seed: 5.5,
        colors: ['#2b7fa8', '#6fd3e0', '#e6fbff'], atmo: '#7fe8ff', atmoStrength: 1.0,
    });

    // ---------- Asteroid belt ----------
    const beltCount = lowPower ? 380 : 950;
    const belt = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 0),
        new THREE.MeshStandardMaterial({ color: 0x9a8f86, roughness: 0.95, metalness: 0, flatShading: true }),
        beltCount,
    );
    {
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new V3(), s = new V3();
        for (let i = 0; i < beltCount; i++) {
            const r = 36 + gauss() * 2.4, a = Math.random() * Math.PI * 2;
            p.set(Math.cos(a) * r, gauss() * 0.7, Math.sin(a) * r);
            q.setFromEuler(e.set(rand(0, 6.3), rand(0, 6.3), rand(0, 6.3)));
            const k = 0.06 + Math.pow(Math.random(), 3) * 0.42;
            s.set(k * rand(0.7, 1.3), k * rand(0.6, 1.1), k * rand(0.7, 1.4));
            belt.setMatrixAt(i, m.compose(p, q, s));
        }
    }
    scene.add(belt);

    // ---------- Stars ----------
    const starCount = lowPower ? 2200 : 5200;
    const starPos = new Float32Array(starCount * 3);
    const starCol = new Float32Array(starCount * 3);
    const starSize = new Float32Array(starCount);
    const starPhase = new Float32Array(starCount);
    const palette = ['#ffffff', '#cfe0ff', '#ffe9c4', '#a9c7ff', '#ffd2a1'].map((c) => new THREE.Color(c));
    const bandTilt = new THREE.Euler(0.55, 0, 0.35);
    for (let i = 0; i < starCount; i++) {
        const v = new V3();
        if (Math.random() < 0.38) {
            const a = Math.random() * Math.PI * 2;
            v.set(Math.cos(a), gauss() * 0.1, Math.sin(a)).applyEuler(bandTilt);
        } else {
            v.set(gauss(), gauss(), gauss());
        }
        v.normalize().multiplyScalar(rand(500, 1300));
        starPos.set([v.x, v.y, v.z], i * 3);
        const c = palette[(Math.random() * palette.length) | 0];
        starCol.set([c.r, c.g, c.b], i * 3);
        starSize[i] = 1.6 + Math.pow(Math.random(), 7) * 9;
        starPhase[i] = Math.random();
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(starCol, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1));
    const starMat = new THREE.ShaderMaterial({
        uniforms: { uTime: timeUniform, uPR: { value: dpr }, uTwinkle: { value: reduceMotion ? 0 : 1 } },
        vertexShader: /* glsl */ `
            attribute vec3 aColor; attribute float aSize; attribute float aPhase;
            uniform float uTime, uPR, uTwinkle;
            varying vec3 vColor; varying float vAlpha;
            void main(){
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mv;
                float tw = 1.0 - uTwinkle * (0.3 + 0.3 * sin(uTime * (0.6 + aPhase * 2.0) + aPhase * 40.0));
                gl_PointSize = max(aSize * uPR * (420.0 / -mv.z), 1.2 * uPR);
                vColor = aColor;
                vAlpha = tw * clamp(aSize / 3.0, 0.35, 1.0);
            }
        `,
        fragmentShader: /* glsl */ `
            varying vec3 vColor; varying float vAlpha;
            void main(){
                float d = length(gl_PointCoord - 0.5);
                float a = pow(smoothstep(0.5, 0.0, d), 1.6) * vAlpha;
                gl_FragColor = vec4(vColor * a, a);
                #include <colorspace_fragment>
            }
        `,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.Points(starGeo, starMat));

    // ---------- Nebulae ----------
    // Drawn procedurally rather than from a canvas texture: canvas gradients are
    // dithered, and that pattern shows up as a grid once the texture is magnified.
    const nebulaMat = (a, b, seed, strength) => new THREE.ShaderMaterial({
        uniforms: { uA: { value: new THREE.Color(a) }, uB: { value: new THREE.Color(b) }, uSeed: { value: seed }, uStrength: { value: strength } },
        vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main(){
                vUv = uv;
                // Billboard: expand the quad in view space so it always faces the camera.
                vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                mv.xy += position.xy * vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform vec3 uA, uB; uniform float uSeed, uStrength;
            varying vec2 vUv;
            ${NOISE}
            float fbm3(vec3 p){ return 0.5 * snoise(p) + 0.25 * snoise(p * 2.03 + 1.7) + 0.125 * snoise(p * 4.1 - 2.3); }
            void main(){
                vec2 q = vUv * 2.0 - 1.0;
                float r = length(q);
                if (r > 1.0) discard;
                float n = fbm3(vec3(q * 1.4, uSeed));
                float n2 = fbm3(vec3(q * 3.0 + 5.0, uSeed + 3.0));
                float mask = pow(smoothstep(1.0, 0.0, r), 1.6);
                float d = mask * smoothstep(-0.3, 0.6, n + 0.35 * n2);
                vec3 col = mix(uA, uB, smoothstep(-0.4, 0.5, n2));
                gl_FragColor = vec4(col * d * uStrength, 1.0);
                #include <colorspace_fragment>
            }
        `,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const nebulaGeo = new THREE.PlaneGeometry(1, 1);
    [
        { p: [-600, 160, -950], s: 1300, a: '#7846c8', b: '#3c6edc', seed: 1.0 },
        { p: [900, -220, -520], s: 1000, a: '#2896b4', b: '#5a3cbe', seed: 4.0 },
        { p: [-420, -80, 980], s: 1150, a: '#c8468c', b: '#6e3cc8', seed: 7.0 },
        { p: [120, -1100, 80], s: 1500, a: '#465ad2', b: '#9646be', seed: 10.0 },
        { p: [1000, 420, 600], s: 900, a: '#dc7850', b: '#8c3caa', seed: 13.0 },
    ].forEach((n) => {
        const m = new THREE.Mesh(nebulaGeo, nebulaMat(n.a, n.b, n.seed, 0.2));
        m.position.set(...n.p);
        m.scale.set(n.s, n.s, 1);
        m.frustumCulled = false;
        m.renderOrder = -1;
        scene.add(m);
    });

    // ---------- Camera shots ----------
    const origin = new V3();
    const UP = new V3(0, 1, 0);
    // Frame a planet with an offset in its own orbital frame:
    // out = away from the sun (negative = between planet and sun), up, tan = along the orbit.
    function around(body, out, up, tan, side, drop = 0) {
        const p = body.pivot.position;
        const o = new V3(p.x, 0, p.z).normalize();
        const t = new V3(-o.z, 0, o.x);
        const offset = o.multiplyScalar(out).addScaledVector(UP, up).addScaledVector(t, tan);
        return { target: p.clone(), offset, side, drop, wide: false };
    }
    const wide = (offset, side, drop = 0) => ({ target: origin.clone(), offset: offset.clone(), side, drop, wide: true });
    // side: desktop only, +1 = scene shifted right (content on the left), -1 = the reverse.
    // drop: phones only, fraction of the screen height to push the scene down.
    const shots = {
        home: () => wide(new V3(0, 38, 112), 1, 0.27),
        about: () => around(terra, -4.5, -2.6, 7.5, -1),
        expertise: () => around(kronos, -10, 7, 18, 1),
        projects: () => around(thalassa, 5, 3, 12, 0),
        contact: () => wide(new V3(0, 150, 45), 0),
    };

    let anchors = [];
    const shotEls = [...document.querySelectorAll('[data-cam]')];
    function measure() {
        const vh = window.innerHeight;
        const maxScroll = Math.max(0, root.scrollHeight - vh);
        const list = [];
        shotEls.forEach((el) => {
            const r = el.getBoundingClientRect();
            const top = r.top + window.scrollY;
            const key = el.dataset.cam;
            if (r.height > vh * 1.3) {
                // Long sections: hold the shot for the whole time the section fills the screen.
                list.push({ key, y: top - vh * 0.15 }, { key, y: top + r.height - vh * 0.85 });
            } else {
                list.push({ key, y: top + r.height / 2 - vh / 2 });
            }
        });
        list.forEach((a) => (a.y = Math.min(Math.max(a.y, 0), maxScroll)));
        if (list.length) list[0].y = 0;
        anchors = list;
    }

    const lerp = (a, b, t) => a + (b - a) * t;
    const smooth = (t) => t * t * (3 - 2 * t);

    // Shot -> world camera position, pulled back on narrow (portrait) screens.
    // Close-ups only pull back a little: cropping a planet on a phone is fine,
    // and pulling further would push the camera into the sun's glow.
    function resolve(shot, fit) {
        const f = shot.wide ? Math.min(fit, 1.7) : Math.min(fit, 1.25);
        return { target: shot.target, pos: shot.target.clone().addScaledVector(shot.offset, f), side: shot.side, drop: shot.drop };
    }

    // Blend camera positions in cylindrical coordinates around the sun so that
    // transitions arc around it instead of cutting straight through.
    function blend(A, B, t) {
        const ra = Math.hypot(A.pos.x, A.pos.z), rb = Math.hypot(B.pos.x, B.pos.z);
        const ta = Math.atan2(A.pos.z, A.pos.x);
        let d = Math.atan2(B.pos.z, B.pos.x) - ta;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const r = lerp(ra, rb, t), th = ta + d * t;
        return {
            pos: new V3(Math.cos(th) * r, lerp(A.pos.y, B.pos.y, t), Math.sin(th) * r),
            target: new V3().lerpVectors(A.target, B.target, t),
            side: lerp(A.side, B.side, t),
            drop: lerp(A.drop, B.drop, t),
        };
    }

    function cameraAt(y, fit) {
        if (!anchors.length) return resolve(shots.home(), fit);
        if (y <= anchors[0].y) return resolve(shots[anchors[0].key](), fit);
        for (let i = 0; i < anchors.length - 1; i++) {
            const a = anchors[i], b = anchors[i + 1];
            if (y <= b.y) {
                const span = b.y - a.y;
                const t = span < 1 ? 1 : smooth(Math.min(Math.max(((y - a.y) / span - 0.1) / 0.8, 0), 1));
                const A = resolve(shots[a.key](), fit);
                if (a.key === b.key) return A;
                return blend(A, resolve(shots[b.key](), fit), t);
            }
        }
        return resolve(shots[anchors[anchors.length - 1].key](), fit);
    }

    // ---------- Interaction ----------
    const pointer = { x: 0, y: 0, sx: 0, sy: 0, ndc: new THREE.Vector2(), target: null, dirty: false };
    const tip = document.getElementById('planet-tip');
    const raycaster = new THREE.Raycaster();
    const pickables = [sun, ...bodies.map((b) => b.mesh)];
    let hovered = null;
    const isUI = (el) => !!(el && el.closest && el.closest('a, button, .glass, .hero-copy, .section-head, .site-header, .orbit-nav'));

    if (!coarse) {
        window.addEventListener('pointermove', (e) => {
            pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
            pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
            pointer.ndc.set(pointer.x, -pointer.y);
            pointer.clientX = e.clientX;
            pointer.clientY = e.clientY;
            pointer.target = e.target;
            pointer.dirty = true;
        }, { passive: true });
        window.addEventListener('click', (e) => {
            if (!hovered || isUI(e.target)) return;
            const el = document.querySelector(hovered.userData.section);
            if (el) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
        });
    }

    function pick() {
        if (!pointer.dirty) return;
        pointer.dirty = false;
        let hit = null;
        if (!isUI(pointer.target)) {
            raycaster.setFromCamera(pointer.ndc, camera);
            const hits = raycaster.intersectObjects(pickables, false);
            hit = hits.length ? hits[0].object : null;
        }
        hovered = hit;
        root.classList.toggle('planet-hover', !!hit);
        if (hit) {
            const name = hit.userData.label;
            const where = document.querySelector(`.orbit-nav a[href="${hit.userData.section}"]`);
            tip.textContent = `${name} · ${where ? where.dataset.label : ''}`;
            tip.style.transform = `translate(${pointer.clientX + 16}px, ${pointer.clientY + 16}px)`;
            tip.hidden = false;
        } else {
            tip.hidden = true;
        }
    }

    // ---------- Resize ----------
    let W = 1, H = 1;
    function resize() {
        W = canvas.clientWidth || window.innerWidth;
        H = canvas.clientHeight || window.innerHeight;
        renderer.setSize(W, H, false);
        camera.aspect = W / H;
        starMat.uniforms.uPR.value = dpr;
        measure();
    }
    window.addEventListener('resize', resize);
    window.addEventListener('load', measure);
    if (document.fonts) document.fonts.ready.then(measure);
    if ('ResizeObserver' in window) new ResizeObserver(() => measure()).observe(document.body);
    resize();

    // ---------- Loop ----------
    let smoothY = window.scrollY;
    let side = 0, drop = 0;
    const camPos = new V3(), camTarget = new V3();
    const fwd = new V3(), right = new V3(), upv = new V3();
    let last = performance.now();
    let sceneTime = 20; // start mid-orbit so things are already in motion
    let perfFrames = 0, perfTotal = 0, firstFrame = true;
    const startedAt = last;

    renderer.compile(scene, camera);

    function frame(now) {
        const rawDt = (now - last) / 1000;
        const dt = Math.min(rawDt, 0.05);
        last = now;
        sceneTime += dt * (reduceMotion ? 0.2 : 1);
        timeUniform.value = sceneTime;

        // Drop resolution once if the device can't keep up.
        if (perfFrames >= 0 && now - startedAt > 1500) {
            perfFrames++;
            perfTotal += rawDt;
            if (perfFrames === 90) {
                if (perfTotal / 90 > 1 / 42 && dpr > 1) {
                    dpr = Math.max(1, dpr * 0.66);
                    renderer.setPixelRatio(dpr);
                    resize();
                }
                perfFrames = -1;
            }
        }

        bodies.forEach((b) => b.update(sceneTime));
        belt.rotation.y = sceneTime * 0.008;

        const k = 1 - Math.exp(-dt * 5);
        smoothY += (window.scrollY - smoothY) * k;
        const aspect = W / H;
        const desktop = W >= 900 && aspect > 1.1;
        const fit = Math.min(Math.max(1.25 / aspect, 1), 2.4);
        const shot = cameraAt(smoothY, fit);

        const wantSide = desktop ? shot.side : 0;
        const wantDrop = desktop ? 0 : shot.drop;
        if (firstFrame) {
            side = wantSide;
            drop = wantDrop;
        } else {
            side += (wantSide - side) * k;
            drop += (wantDrop - drop) * k;
        }
        camPos.copy(shot.pos);
        camTarget.copy(shot.target);

        if (!coarse && !reduceMotion) {
            pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-dt * 2.5));
            pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-dt * 2.5));
            fwd.subVectors(camTarget, camPos);
            const dist = fwd.length();
            fwd.normalize();
            right.crossVectors(fwd, UP);
            if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
            right.normalize();
            upv.crossVectors(right, fwd);
            camPos.addScaledVector(right, pointer.sx * dist * 0.035).addScaledVector(upv, -pointer.sy * dist * 0.025);
        }

        camera.position.copy(camPos);
        camera.lookAt(camTarget);
        camera.setViewOffset(W, H, -side * W * 0.22, -drop * H, W, H);

        pick();
        renderer.render(scene, camera);

        if (firstFrame) {
            firstFrame = false;
            canvas.classList.add('ready');
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}
